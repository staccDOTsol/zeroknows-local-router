"""Reviewed leCore lexical retrieval subset; see PROVENANCE.md and LICENSE.

No engine initialization, filesystem access, network calls, or learned embeddings.
The caller owns session isolation, source persistence, budgets and zero-score filtering.
"""
# Copyright (c) 2026 AnOversizedMooseWithSocks; MIT License.
import math
from collections import Counter
import re
import numpy as np

_STOP = frozenset('a an the of to in on at for and or is are be by with from as it this that these those into over under out up down off no not do does did can could would should will your my our their its his her you we they i he she them us me'.split())

def _normalize(tok):
    for suf in ('ing', 'ed', 'es', 's'):
        if tok.endswith(suf) and len(tok) - len(suf) >= 3:
            return tok[:-len(suf)]
    return tok

def tokenize(text):
    toks = re.findall('[a-z0-9]+', text.lower())
    return [_normalize(t) for t in toks if t not in _STOP and len(t) > 1]
_DERIV_REWRITES = (('ational', 'ate'), ('ization', 'ize'), ('iveness', 'ive'), ('fulness', 'ful'), ('ousness', 'ous'), ('ibility', 'ible'), ('ability', 'able'), ('ivity', 'ive'), ('ution', 'ute'), ('ation', 'ate'), ('ition', 'ite'))
_DERIV_STRIPS = ('ancy', 'ency', 'ance', 'ence', 'ment', 'able', 'ible', 'ive', 'ion', 'ous', 'ity', 'al', 'ic')
_VOWELS = frozenset('aeiou')

def _measure(stem):
    m = 0
    prev_v = False
    for i, ch in enumerate(stem):
        v = ch in _VOWELS or (ch == 'y' and i > 0)
        if prev_v and (not v):
            m += 1
        prev_v = v
    return m

def _derivational_stem(tok):
    for suf, rep in _DERIV_REWRITES:
        if tok.endswith(suf):
            stem = tok[:-len(suf)]
            if _measure(stem) >= 1:
                return stem + rep
            return tok
    for suf in _DERIV_STRIPS:
        if tok.endswith(suf):
            stem = tok[:-len(suf)]
            if _measure(stem) >= 2:
                return stem
            return tok
    return tok

def tokenize_once(x):
    if isinstance(x, str):
        return tokenize(x)
    return list(x)

class BM25:
    """Okapi BM25 over a fixed corpus of documents. Build once (fit the idf + lengths), then score any query in
    O(query_terms * postings). Pure NumPy/stdlib; deterministic. k1 controls term-frequency saturation (the
    first occurrences of a term matter most, later ones saturate); b controls document-length normalization
    (b=1 full, b=0 none). Defaults k1=1.5, b=0.75 are the standard Robertson values."""

    def __init__(self, docs, k1=1.5, b=0.75, slim=False, stats=None):
        if slim:
            raise ValueError('Cold-store/slim mode is excluded from the reviewed local subset')
        self.k1 = float(k1)
        self.b = float(b)
        self.docs_tokens = [tokenize_once(d) for d in docs]
        self.N = len(self.docs_tokens)
        self.doc_len = np.array([len(t) for t in self.docs_tokens], dtype=np.float64)
        self.avgdl = float(self.doc_len.mean()) if self.N else 0.0
        self.tf = []
        df = {}
        for toks in self.docs_tokens:
            counts = {}
            for t in toks:
                counts[t] = counts.get(t, 0) + 1
            self.tf.append(counts)
            for t in counts:
                df[t] = df.get(t, 0) + 1
        self.idf = {t: math.log(1.0 + (self.N - n + 0.5) / (n + 0.5)) for t, n in df.items()}
        if stats:
            if 'avgdl' in stats:
                self.avgdl = float(stats['avgdl'])
            if 'idf' in stats:
                self.idf = dict(stats['idf'])
            self._corpus_N = int(stats.get('N', self.N))
        post = {}
        for i in range(self.N):
            dl = self.doc_len[i]
            for term, f in self.tf[i].items():
                denom = f + self.k1 * (1.0 - self.b + self.b * dl / (self.avgdl + 1e-12))
                lists = post.get(term)
                if lists is None:
                    lists = post[term] = ([], [])
                lists[0].append(i)
                lists[1].append(self.idf[term] * (f * (self.k1 + 1.0)) / (denom + 1e-12))
        self._postings = {term: (np.array(idxs, dtype=np.int64), np.array(wts, dtype=np.float64)) for term, (idxs, wts) in post.items()}
        self._stem_terms = {}
        for term in self._postings:
            self._stem_terms.setdefault(_derivational_stem(term), []).append(term)
        for stem in self._stem_terms:
            self._stem_terms[stem].sort()

    def _corpus_stats(self):
        return (self.tf, self.docs_tokens)

    def corpus_stats(self):
        return {'N': self.N, 'avgdl': self.avgdl, 'idf': dict(self.idf)}

    def scores(self, query, expand=False):
        q_terms = tokenize_once(query)
        out = np.zeros(self.N, dtype=np.float64)
        if not q_terms:
            return out
        for t, c in Counter(q_terms).items():
            post = self._postings.get(t)
            if post is None:
                continue
            idxs, wts = post
            out[idxs] += float(c) * wts
        if expand:
            for t_, c in Counter(q_terms).items():
                for sib in self._stem_terms.get(_derivational_stem(t_), ()):
                    if sib == t_:
                        continue
                    post = self._postings.get(sib)
                    if post is not None:
                        idxs, wts = post
                        out[idxs] += 0.5 * float(c) * wts
        return out

    def _scores_reference(self, query):
        q_terms = tokenize_once(query)
        out = np.zeros(self.N, dtype=np.float64)
        if not q_terms:
            return out
        tf, _ = self._corpus_stats()
        for t, c in Counter(q_terms).items():
            idf = self.idf.get(t)
            if idf is None:
                continue
            for i in range(self.N):
                f = tf[i].get(t, 0)
                if f == 0:
                    continue
                denom = f + self.k1 * (1.0 - self.b + self.b * self.doc_len[i] / (self.avgdl + 1e-12))
                out[i] += float(c) * (idf * (f * (self.k1 + 1.0)) / (denom + 1e-12))
        return out

    def rank(self, query, top=None, expand=False):
        s = self.scores(query, expand=expand)
        if top and top < len(s):
            order = topk_det(s, top)
        else:
            order = np.lexsort((np.arange(len(s)), -s))[:top] if top else np.lexsort((np.arange(len(s)), -s))
        ranked = [(int(i), float(s[i])) for i in order]
        return ranked

def chunk_text(text, max_chars=600, min_chars=40, overlap=300):
    paras = [p.strip() for p in str(text).replace('\r\n', '\n').split('\n\n')]
    out, buf = ([], '')
    for p in paras:
        if not p:
            continue
        if len(buf) + len(p) + 2 <= max_chars:
            buf = buf + '\n\n' + p if buf else p
        else:
            if len(buf) >= min_chars:
                out.append(buf)
            if len(p) > max_chars:
                step = max(1, max_chars - min(int(overlap), max_chars // 2))
                while len(p) > max_chars:
                    out.append(p[:max_chars])
                    p = p[step:]
            buf = p
    if len(buf) >= min_chars or (buf and (not out)):
        out.append(buf)
    return out

def topk_det(scores, k):
    s = np.asarray(scores)
    n = s.shape[0]
    kk = int(min(k, n))
    if kk <= 0:
        return np.empty(0, dtype=np.int64)
    if kk == n:
        short = np.arange(n)
    else:
        part = np.argpartition(-s, kk - 1)
        short = np.where(s >= s[part[kk - 1]])[0]
    return short[np.lexsort((short, -s[short]))][:kk].astype(np.int64)
