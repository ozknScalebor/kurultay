/** Minimal unified diff (LCS based) – no external tools needed. */

interface Op {
  t: ' ' | '-' | '+';
  line: string;
}

function lcsOps(a: string[], b: string[]): Op[] {
  // trim common prefix/suffix to keep the DP small
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const A = a.slice(start, endA);
  const B = b.slice(start, endB);
  const ops: Op[] = a.slice(0, start).map((line) => ({ t: ' ' as const, line }));
  if (A.length * B.length > 4_000_000) {
    // too big for DP: fall back to replace-all for the middle part
    for (const l of A) ops.push({ t: '-', line: l });
    for (const l of B) ops.push({ t: '+', line: l });
  } else {
    const n = A.length;
    const m = B.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) {
        ops.push({ t: ' ', line: A[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: '-', line: A[i++] });
      else ops.push({ t: '+', line: B[j++] });
    }
    while (i < n) ops.push({ t: '-', line: A[i++] });
    while (j < m) ops.push({ t: '+', line: B[j++] });
  }
  for (const l of a.slice(endA)) ops.push({ t: ' ', line: l });
  return ops;
}

export function unifiedDiff(path: string, before: string | undefined, after: string | undefined, context = 3): string {
  const a = before === undefined ? [] : before.split('\n');
  const b = after === undefined ? [] : after.split('\n');
  const ops = lcsOps(a, b);
  const header = `--- ${before === undefined ? '/dev/null' : 'a/' + path}\n+++ ${after === undefined ? '/dev/null' : 'b/' + path}\n`;
  const hunks: string[] = [];
  let i = 0;
  let aLine = 1;
  let bLine = 1;
  while (i < ops.length) {
    if (ops[i].t === ' ') {
      i++;
      aLine++;
      bLine++;
      continue;
    }
    // start hunk with context
    const ctxStart = Math.max(0, i - context);
    let hA = aLine - (i - ctxStart);
    let hB = bLine - (i - ctxStart);
    const lines: string[] = [];
    for (let k = ctxStart; k < i; k++) lines.push(' ' + ops[k].line);
    let lastChange = i;
    let k = i;
    let cA = 0;
    let cB = 0;
    for (let x = ctxStart; x < i; x++) {
      cA++;
      cB++;
    }
    while (k < ops.length && k - lastChange <= context * 2) {
      const op = ops[k];
      lines.push(op.t + op.line);
      if (op.t !== ' ') lastChange = k;
      if (op.t !== '+') cA++;
      if (op.t !== '-') cB++;
      k++;
    }
    // trim trailing context beyond `context`
    let trailing = k - 1 - lastChange;
    while (trailing > context) {
      lines.pop();
      cA--;
      cB--;
      trailing--;
    }
    const consumed = lastChange + 1 + Math.min(context, k - 1 - lastChange);
    for (let x = i; x < consumed; x++) {
      if (ops[x].t !== '+') aLine++;
      if (ops[x].t !== '-') bLine++;
    }
    if (a.length === 0) hA = 0;
    if (b.length === 0) hB = 0;
    hunks.push(`@@ -${hA},${cA} +${hB},${cB} @@\n${lines.join('\n')}`);
    i = consumed;
  }
  if (!hunks.length) return '';
  return header + hunks.join('\n') + '\n';
}

export function diffStat(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) added++;
    else if (l.startsWith('-') && !l.startsWith('---')) removed++;
  }
  return { added, removed };
}
