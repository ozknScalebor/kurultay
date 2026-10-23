/** Line-based three-way merge (diff3-lite) used when parallel workers touch the same file. */

interface Hunk {
  baseStart: number; // inclusive line index in base
  baseEnd: number; // exclusive
  lines: string[];
}

function hunks(base: string[], other: string[]): Hunk[] {
  const n = base.length;
  const m = other.length;
  if (n * m > 6_000_000) return [{ baseStart: 0, baseEnd: n, lines: other }];
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = base[i] === other[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Hunk[] = [];
  let i = 0;
  let j = 0;
  let cur: Hunk | undefined;
  const flush = () => {
    if (cur) out.push(cur);
    cur = undefined;
  };
  while (i < n || j < m) {
    if (i < n && j < m && base[i] === other[j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      cur ??= { baseStart: i, baseEnd: i, lines: [] };
      cur.lines.push(other[j++]);
    } else {
      cur ??= { baseStart: i, baseEnd: i, lines: [] };
      i++;
      cur.baseEnd = i;
    }
  }
  flush();
  return out;
}

export interface MergeResult {
  ok: boolean;
  content: string;
  conflicts: number;
}

/** Merge `mine` and `theirs`, both derived from `base`. Conflicts are marked git-style. */
export function merge3(base: string, mine: string, theirs: string): MergeResult {
  if (mine === theirs) return { ok: true, content: mine, conflicts: 0 };
  if (base === mine) return { ok: true, content: theirs, conflicts: 0 };
  if (base === theirs) return { ok: true, content: mine, conflicts: 0 };
  const B = base.split('\n');
  const a = hunks(B, mine.split('\n')).map((h) => ({ ...h, side: 'mine' as const }));
  const b = hunks(B, theirs.split('\n')).map((h) => ({ ...h, side: 'theirs' as const }));
  const all = [...a, ...b].sort((x, y) => x.baseStart - y.baseStart || x.baseEnd - y.baseEnd);
  const out: string[] = [];
  let pos = 0;
  let conflicts = 0;
  let k = 0;
  while (k < all.length) {
    // group overlapping hunks
    const group = [all[k]];
    let end = all[k].baseEnd;
    let g = k + 1;
    while (g < all.length && (all[g].baseStart < end || (all[g].baseStart === end && all[g].baseStart === all[g].baseEnd && group.some((h) => h.baseStart === h.baseEnd && h.baseStart === end)))) {
      group.push(all[g]);
      end = Math.max(end, all[g].baseEnd);
      g++;
    }
    const start = Math.min(...group.map((h) => h.baseStart));
    out.push(...B.slice(pos, start));
    const sides = new Set(group.map((h) => h.side));
    const render = (side: 'mine' | 'theirs') => {
      const res: string[] = [];
      let p = start;
      for (const h of group.filter((x) => x.side === side)) {
        res.push(...B.slice(p, h.baseStart), ...h.lines);
        p = h.baseEnd;
      }
      res.push(...B.slice(p, end));
      return res;
    };
    if (sides.size === 1) {
      out.push(...render(group[0].side));
    } else {
      const m = render('mine');
      const t = render('theirs');
      if (m.join('\n') === t.join('\n')) out.push(...m);
      else {
        conflicts++;
        out.push('<<<<<<< kurultay (this worker)', ...m, '=======', ...t, '>>>>>>> current');
      }
    }
    pos = end;
    k = g;
  }
  out.push(...B.slice(pos));
  return { ok: conflicts === 0, content: out.join('\n'), conflicts };
}
