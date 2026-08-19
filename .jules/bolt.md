## 2025-05-18 - Flat Int32Array LCS Matrix for Line Diffing

**Learning:** Hand-rolled DP LCS algorithms allocating 2D JS arrays (`Array.from({ length: n + 1 }, () => new Array(m + 1))`) create $O(N)$ object allocations and incur CPU pointer indirection and GC pressure when diffing longer text files in React editors. Replacing 2D nested arrays with a single flat `Int32Array` indexed by stride (`i * stride + j`) keeps memory allocation $O(1)$ and significantly improves CPU cache locality.

**Action:** Whenever implementing or optimizing Dynamic Programming matrix computations (such as LCS or Levenshtein distance), use a single flat typed array (`Int32Array` or `Float64Array`) with stride offsets instead of nested standard arrays.
