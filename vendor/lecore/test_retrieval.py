"""Synthetic, model-free tests for the reviewed vendored subset."""
import unittest

import numpy as np

from retrieval import BM25, chunk_text, topk_det


class RetrievalSubsetTests(unittest.TestCase):
    def test_short_paragraphs_are_retained_when_requested(self):
        chunks = chunk_text("OK\n\n" + "abcdefghij" * 10 + "\n\nYes", max_chars=40, min_chars=1, overlap=20)
        self.assertEqual(chunks[0], "OK")
        self.assertTrue(any("Yes" in chunk for chunk in chunks))
        self.assertTrue(all(0 < len(chunk) <= 40 for chunk in chunks))
        self.assertEqual(chunk_text("x", min_chars=1), ["x"])
        self.assertEqual(chunk_text(" \n\n ", min_chars=1), [])

    def test_lexical_scores_and_zero_signal(self):
        bm = BM25(["red apples", "blue berries", "red apples"])
        scores = bm.scores("apples")
        self.assertGreater(scores[0], 0)
        self.assertEqual(scores[1], 0)
        self.assertEqual(scores[0], scores[2])
        self.assertEqual(bm.rank("apples", top=2), [(0, float(scores[0])), (2, float(scores[2]))])
        np.testing.assert_array_equal(bm.scores("quartz"), np.zeros(3))
        np.testing.assert_array_equal(bm.scores("the and"), np.zeros(3))

    def test_repeated_terms_and_reference_are_bit_identical(self):
        bm = BM25(["settings settings apple", "settings pear", "pear apple", ""])
        for query in ["settings", "settings settings pear", "apple pear apple", "", "quartz"]:
            np.testing.assert_array_equal(bm.scores(query), bm._scores_reference(query))
        np.testing.assert_array_equal(bm.scores("settings settings"), 2 * bm.scores("settings"))
        # Pretokenized input must not be normalized a second time.
        self.assertGreater(BM25([["settings"]]).scores(["settings"])[0], 0)

    def test_topk_ties_match_stable_full_sort(self):
        rng = np.random.default_rng(42)
        for n in [0, 1, 5, 100]:
            scores = rng.integers(0, 4, size=n).astype(float)
            for k in [0, 1, 3, n, n + 4]:
                expected = np.lexsort((np.arange(n), -scores))[:min(k, n)]
                np.testing.assert_array_equal(topk_det(scores, k), expected)
        np.testing.assert_array_equal(topk_det([5, 5, 5, 5], 2), [0, 1])

    def test_no_coldstore_path_and_empty_corpus(self):
        with self.assertRaisesRegex(ValueError, "excluded"):
            BM25(["apple"], slim=True)
        self.assertEqual(BM25([]).rank("apple", top=3), [])
        self.assertEqual(BM25([]).scores("apple").shape, (0,))


if __name__ == "__main__":
    unittest.main()
