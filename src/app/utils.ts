export function parsePercentiles(str: string): number[] {
  return (str || '')
    .split(/[ ,]+/)
    .map((s) => Number(s))
    .filter((v) => Number.isFinite(v) && v > 0 && v < 100);
}

export function nearestRank(sorted: number[], p: number): number {
  const n = sorted.length;
  if (!n) return NaN;
  const rank = Math.ceil((p / 100) * n);
  return sorted[Math.min(Math.max(rank - 1, 0), n - 1)];
}

export function linearInterp(sorted: number[], p: number): number {
  const n = sorted.length;
  if (!n) return NaN;
  const pos = (p / 100) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const frac = pos - lo;
  if (hi >= n) return sorted[n - 1];
  return sorted[lo] + frac * (sorted[hi] - sorted[lo]);
}

export function extractJson(line: string): any | null {
  const first = line.indexOf('{');
  const last = line.lastIndexOf('}');
  if (first < 0 || last < first) return null;
  try {
    return JSON.parse(line.slice(first, last + 1));
  } catch {
    return null;
  }
}
