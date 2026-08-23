## 2026-08-05 - Flat Int32Array for LCS DP Matrix
**Learning:** Hand-rolled dynamic programming algorithms (like line-level LCS diffs) that initialize 2D matrices via `Array.from({ length: N }, () => new Array(M))` allocate $O(N)$ heap Array objects and generate heavy GC pressure.
**Action:** Flatten 2D matrices into a single contiguous 1D `Int32Array(N * M)` buffer for zero object allocation overhead and significantly faster array indexing.
