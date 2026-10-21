#!/usr/bin/env python3
"""Local JSON-lines retrieval worker. No network, model, file-ingestion or tool execution.

Only the administrator-selected SQLite path is opened. Documents arrive explicitly
through append. SQLite transactions own persistence and cross-process write locks.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import sys
from collections import OrderedDict

sys.path.insert(0, str(Path(__file__).resolve().parent / 'vendor' / 'lecore'))
from retrieval import BM25, chunk_text, topk_det, tokenize

# Ported from openzoo-ingest/daemon/rank.py: drop instruction boilerplate from the
# query and add joined forms of dotted/hyphenated compounds (pump.fun -> pumpfun).
_INSTRUCTION_WORDS = frozenset('''
list lists listing every all each any find finding found show shows tell give
gives provide mention mentions mentioned distinct exhaustive exhaustively
comprehensive complete completely please can could would you your me my we our
with without context including include included detail details detailed
explain describe summarise summarize summary about regarding concerning
question answer please thanks thank
what which where when who whom whose why how
is are was were be been being do does did done has have had
the a an of to in on for from by as at and or but if then than that this these
those it its there here also more most some many much very just only
'''.split())


def normalize_query(query):
    kept = [t for t in tokenize(query or '') if t not in _INSTRUCTION_WORDS]
    for m in re.findall(r'[A-Za-z0-9]+(?:[.\-_][A-Za-z0-9]+)+', query or ''):
        joined = re.sub(r'[.\-_]', '', m).lower()
        if joined and joined not in kept:
            kept.append(joined)
    return ' '.join(kept)

MAX_DOCUMENT_BYTES = 65536
MAX_SESSION_BYTES = 1024 * 1024 * 1024
MAX_TOTAL_BYTES = 64 * 1024 * 1024 * 1024
MAX_DOCUMENTS = 1000000
MAX_SESSIONS = 1000000
MAX_LINE_BYTES = 300000


class RequestError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def check(condition, message, status=400):
    if not condition:
        raise RequestError(status, message)


def keys(value, allowed):
    check(isinstance(value, dict) and not (set(value) - set(allowed)), 'Unknown or invalid memory fields')


class Store:
    def __init__(self, directory):
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(directory / 'sessions.sqlite3', timeout=10)
        self.db.execute('PRAGMA foreign_keys = ON')
        self.db.execute('PRAGMA synchronous = FULL')
        # Rollback journaling gives atomic commits without persistent WAL snapshots.
        self.db.execute('PRAGMA journal_mode = DELETE')
        self.db.execute('PRAGMA secure_delete = ON')
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS metadata (version INTEGER NOT NULL);
          INSERT INTO metadata SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM metadata);
          CREATE TABLE IF NOT EXISTS sessions (key TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS documents (
            session TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
            id TEXT NOT NULL, version INTEGER NOT NULL, text TEXT NOT NULL, bytes INTEGER NOT NULL,
            PRIMARY KEY(session, id));
        ''')
        check(self.db.execute('SELECT version FROM metadata').fetchall() == [(1,)], 'Unsupported memory store version', 503)
        self.db.commit()
        if os.name != 'nt':
            os.chmod(directory / 'sessions.sqlite3', 0o600)
        self.cache = OrderedDict()

    def session(self, token):
        check(isinstance(token, str) and re.fullmatch(r'[A-Za-z0-9_-]{43}', token), 'Unknown session', 404)
        key = hashlib.sha256(token.encode()).hexdigest()
        row = self.db.execute('SELECT revision FROM sessions WHERE key=?', (key,)).fetchone()
        check(row is not None, 'Unknown session', 404)
        return key, row[0]

    def run(self, command):
        keys(command, ['action', 'session', 'documents', 'query', 'limit', 'document_ids'])
        action = command.get('action')
        check(action in ('bind', 'append', 'recall', 'delete'), 'Unknown memory action')
        allowed = {'bind': ['action'], 'append': ['action', 'session', 'documents'],
                   'recall': ['action', 'session', 'query', 'limit'],
                   'delete': ['action', 'session', 'document_ids']}[action]
        keys(command, allowed)
        self.db.execute('BEGIN' if action == 'recall' else 'BEGIN IMMEDIATE')
        try:
            result = self._run(action, command)
            self.db.commit()
            return result
        except BaseException:
            self.db.rollback()
            raise

    def _run(self, action, command):
        if action == 'bind':
            check(self.db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0] < MAX_SESSIONS, 'Session quota reached; delete unused sessions', 413)
            token = secrets.token_urlsafe(32)
            key = hashlib.sha256(token.encode()).hexdigest()
            self.db.execute('INSERT INTO sessions(key) VALUES(?)', (key,))
            return {'session': token, 'revision': 0}
        key, revision = self.session(command.get('session'))
        if action == 'append':
            documents = command.get('documents')
            check(isinstance(documents, list) and 1 <= len(documents) <= 32, 'Append requires 1..32 documents')
            result, seen = [], set()
            for document in documents:
                keys(document, ['id', 'version', 'text'])
                text = document.get('text')
                check(isinstance(text, str) and text.strip(), 'Document text must be nonempty')
                size = len(text.encode('utf-8'))
                check(size <= MAX_DOCUMENT_BYTES, 'Document exceeds 64 KiB', 413)
                doc_id = document.get('id')
                if 'id' not in document:
                    check('version' not in document, 'Version requires an existing document id')
                    doc_id, version = secrets.token_hex(16), 1
                else:
                    check(isinstance(doc_id, str) and re.fullmatch(r'[a-f0-9]{32}', doc_id), 'Invalid document id')
                    check(doc_id not in seen, 'Duplicate document id in append')
                    previous = self.db.execute('SELECT version FROM documents WHERE session=? AND id=?', (key, doc_id)).fetchone()
                    check(previous is not None, 'Document not found in this session', 404)
                    check(type(document.get('version')) is int and document['version'] == previous[0], 'Document version conflict', 409)
                    version = previous[0] + 1
                seen.add(doc_id)
                self.db.execute('INSERT OR REPLACE INTO documents VALUES(?,?,?,?,?)', (key, doc_id, version, text, size))
                result.append({'id': doc_id, 'version': version})
            count, size = self.db.execute('SELECT COUNT(*), COALESCE(SUM(bytes),0) FROM documents WHERE session=?', (key,)).fetchone()
            check(count <= MAX_DOCUMENTS and size <= MAX_SESSION_BYTES, 'Session document quota exceeded', 413)
            check(self.db.execute('SELECT COALESCE(SUM(bytes),0) FROM documents').fetchone()[0] <= MAX_TOTAL_BYTES, 'Total memory quota exceeded', 413)
            self.db.execute('UPDATE sessions SET revision=revision+1 WHERE key=?', (key,))
            self.cache.pop(key, None)
            return {'documents': result, 'revision': revision + 1}
        if action == 'delete':
            ids = command.get('document_ids')
            if 'document_ids' not in command:
                self.db.execute('DELETE FROM sessions WHERE key=?', (key,))
                result = {'deleted': 'session'}
            else:
                check(isinstance(ids, list) and 1 <= len(ids) <= MAX_DOCUMENTS and all(isinstance(i, str) and re.fullmatch(r'[a-f0-9]{32}', i) for i in ids), 'Invalid document_ids')
                deleted = 0
                for doc_id in set(ids):
                    deleted += self.db.execute('DELETE FROM documents WHERE session=? AND id=?', (key, doc_id)).rowcount
                self.db.execute('UPDATE sessions SET revision=revision+1 WHERE key=?', (key,))
                result = {'deleted': deleted, 'revision': revision + 1}
            self.cache.pop(key, None)
            return result
        query, limit = command.get('query'), command.get('limit', 4)
        check(isinstance(query, str) and len(query.encode('utf-8')) <= 8192, 'Recall query must be text of at most 8 KiB')
        check(type(limit) is int and 1 <= limit <= 32, 'Recall limit must be 1..32')
        cached = self.cache.get(key)
        if cached is None or cached[0] != revision:
            chunks = []
            for doc_id, version, text in self.db.execute('SELECT id,version,text FROM documents WHERE session=? ORDER BY rowid', (key,)):
                # Upstream default 40 drops short middle paragraphs; 1 preserves them.
                for number, text_chunk in enumerate(chunk_text(text, min_chars=1)):
                    chunks.append({'document_id': doc_id, 'version': version, 'chunk': number, 'text': text_chunk})
            cached = (revision, chunks, BM25([chunk['text'] for chunk in chunks]))
            self.cache[key] = cached
        self.cache.move_to_end(key)
        while len(self.cache) > 4:
            self.cache.popitem(last=False)
        _, chunks, index = cached
        # Raw and normalized query variants, each over-fetched with derivational
        # expansion, merged by reciprocal rank fusion (k=60), as in openzoo-ingest.
        variants = [query]
        normalized = normalize_query(query)
        if normalized and normalized != ' '.join(tokenize(query)):
            variants.append(normalized)
        fused, best = {}, {}
        fetch = max(limit, min(len(chunks), limit * 8))
        for variant in variants:
            scores = index.scores(variant, expand=True)
            for rank, i in enumerate(i for i in topk_det(scores, fetch) if scores[i] > 0):
                i = int(i)
                fused[i] = fused.get(i, 0.0) + 1.0 / (60 + rank + 1)
                best[i] = max(best.get(i, 0.0), float(scores[i]))
        order = sorted(fused, key=lambda i: (-fused[i], i))[:limit]
        matches = [{**chunks[i], 'score': best[i], 'rrf': fused[i]} for i in order]
        return {'revision': revision, 'matches': matches, 'retrieval': 'lecore-bm25-rrf'}


def main():
    store = Store(sys.argv[1])
    for line in sys.stdin.buffer:
        message_id = None
        try:
            check(len(line) <= MAX_LINE_BYTES, 'Memory request too large', 413)
            message = json.loads(line)
            keys(message, ['id', 'command'])
            message_id = message.get('id')
            check(type(message_id) is int, 'Invalid worker request id')
            result = {'id': message_id, 'result': store.run(message.get('command'))}
        except RequestError as exc:
            result = {'id': message_id, 'error': {'status': exc.status, 'message': exc.message}}
        except (ValueError, UnicodeError, TypeError):
            result = {'id': message_id, 'error': {'status': 400, 'message': 'Invalid memory request'}}
        except sqlite3.Error:
            result = {'id': message_id, 'error': {'status': 503, 'message': 'Memory database unavailable; write outcome may be uncertain'}}
        except Exception:
            result = {'id': message_id, 'error': {'status': 503, 'message': 'Local retrieval worker failed'}}
        print(json.dumps(result, ensure_ascii=True), flush=True)


if __name__ == '__main__':
    main()
