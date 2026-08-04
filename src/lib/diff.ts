// Line-level LCS diff for the instruction editor's diff view
// (feature-spec.md:33 "Diff view + rollback"; sketch 06: red removed / green
// added line bands). Hand-rolled — no diff dependency is installed.

export interface DiffLine {
  type: "equal" | "add" | "del";
  line: string;
}

// "" = zero lines; a trailing newline is a terminator, not an extra empty line.
function toLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// Classic LCS dynamic program over the middle section (common prefix/suffix
// trimmed first so typical one-hunk edits stay cheap). Deletions are emitted
// before additions within a mixed hunk.
export function diffLines(a: string, b: string): DiffLine[] {
  const aLines = toLines(a);
  const bLines = toLines(b);

  let start = 0;
  while (start < aLines.length && start < bLines.length && aLines[start] === bLines[start]) {
    start++;
  }
  let endA = aLines.length;
  let endB = bLines.length;
  while (endA > start && endB > start && aLines[endA - 1] === bLines[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = aLines.slice(start, endA);
  const midB = bLines.slice(start, endB);
  const n = midA.length;
  const m = midB.length;

  // lcs[i][j] = LCS length of midA[i..] vs midB[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        midA[i] === midB[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  for (let k = 0; k < start; k++) out.push({ type: "equal", line: aLines[k] });
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      out.push({ type: "equal", line: midA[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: "del", line: midA[i] });
      i++;
    } else {
      out.push({ type: "add", line: midB[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", line: midA[i++] });
  while (j < m) out.push({ type: "add", line: midB[j++] });
  for (let k = endA; k < aLines.length; k++) out.push({ type: "equal", line: aLines[k] });
  return out;
}
