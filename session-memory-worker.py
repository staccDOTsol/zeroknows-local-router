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
from retrieval import BM25, chunk_text, topk_det

MAX_DOCUMENT_BYTES = 65536
MAX_SESSION_BYTES = 4 * 1024 * 1024
MAX_TOTAL_BYTES = 32 * 1024 * 1024
MAX_DOCUMENTS = 256
MAX_SESSIONS = 128
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
        check(type(limit) is int and 1 <= limit <= 8, 'Recall limit must be 1..8')
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
        scores = index.scores(query)
        matches = [{**chunks[int(i)], 'score': float(scores[i])} for i in topk_det(scores, limit) if scores[i] > 0]
        return {'revision': revision, 'matches': matches, 'retrieval': 'lecore-bm25-lexical'}


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
