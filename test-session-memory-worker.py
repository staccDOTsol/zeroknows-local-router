"""Synthetic storage checks; these tests do not ingest external files."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('session_memory_worker', Path(__file__).with_name('session-memory-worker.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class StoreTests(unittest.TestCase):
    def test_original_bytes_and_ids_survive_reopen(self):
        with tempfile.TemporaryDirectory() as directory:
            store = worker.Store(directory)
            session = store.run({'action': 'bind'})['session']
            original = '  ORCHID\r\n\r\nShort\t \n雪 and punctuation.  '
            document = store.run({'action': 'append', 'session': session, 'documents': [{'text': original}]})['documents'][0]
            store.db.close()
            reopened = worker.Store(directory)
            row = reopened.db.execute('SELECT id,version,text,bytes FROM documents').fetchone()
            self.assertEqual(row, (document['id'], 1, original, len(original.encode('utf-8'))))
            self.assertEqual(reopened.db.execute('PRAGMA secure_delete').fetchone()[0], 1)
            self.assertEqual(reopened.run({'action': 'recall', 'session': session, 'query': 'orchid'})['matches'][0]['document_id'], document['id'])
            reopened.db.close()

    def test_document_count_quota_rolls_back_batch(self):
        with tempfile.TemporaryDirectory() as directory:
            store = worker.Store(directory)
            session = store.run({'action': 'bind'})['session']
            for _ in range(8):
                store.run({'action': 'append', 'session': session, 'documents': [{'text': 'small synthetic'} for _ in range(32)]})
            with self.assertRaises(worker.RequestError) as error:
                store.run({'action': 'append', 'session': session, 'documents': [{'text': 'overflow'}]})
            self.assertEqual(error.exception.status, 413)
            self.assertEqual(store.db.execute('SELECT COUNT(*) FROM documents').fetchone()[0], 256)
            self.assertEqual(store.run({'action': 'recall', 'session': session, 'query': 'overflow'})['matches'], [])
            store.db.close()

    def test_delete_is_scoped_and_revokes_session(self):
        with tempfile.TemporaryDirectory() as directory:
            store = worker.Store(directory)
            first, second = [store.run({'action': 'bind'})['session'] for _ in range(2)]
            document = store.run({'action': 'append', 'session': second, 'documents': [{'text': 'persistedneedle'}]})['documents'][0]
            self.assertEqual(store.run({'action': 'delete', 'session': first, 'document_ids': [document['id']]})['deleted'], 0)
            store.run({'action': 'delete', 'session': first})
            with self.assertRaises(worker.RequestError):
                store.run({'action': 'recall', 'session': first, 'query': 'persistedneedle'})
            self.assertEqual(len(store.run({'action': 'recall', 'session': second, 'query': 'persistedneedle'})['matches']), 1)
            store.db.close()


if __name__ == '__main__':
    unittest.main()
