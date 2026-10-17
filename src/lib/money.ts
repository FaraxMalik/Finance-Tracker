/** Amounts are stored as integers in paisa (1 PKR = 100 paisa) to avoid float errors. */

export function toPaisa(input: string): number {
  const n = parseFloat(input.replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function fromPaisa(paisa: number): string {
  const rupees = paisa / 100;
  return Number.isInteger(rupees) ? String(rupees) : rupees.toFixed(2);
}

export function formatPKR(paisa: number, opts: { sign?: boolean } = {}): string {
  const abs = Math.abs(paisa) / 100;
  const body = abs.toLocaleString('en-PK', {
    minimumFractionDigits: Number.isInteger(abs) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  const sign = paisa < 0 ? '-' : opts.sign && paisa > 0 ? '+' : '';
  return `${sign}Rs ${body}`;
}

/**
 * Whole-number percentages of `values` that add up to exactly 100 (largest remainder): rounding each one on its
 * own can give 99% or 101%. All zeros (or nothing) gives zeros.
 */
export function percentShares(values: number[]): number[] {
  const total = values.reduce((s, v) => s + v, 0);
  if (total <= 0) return values.map(() => 0);
  const exact = values.map((v) => (v / total) * 100);
  const out = exact.map(Math.floor);
  const order = exact.map((x, i) => ({ i, rest: x - Math.floor(x) })).sort((a, b) => b.rest - a.rest || a.i - b.i);
  const missing = 100 - out.reduce((s, v) => s + v, 0);
  for (let k = 0; k < missing; k++) out[order[k].i]++;
  return out;
}

/** Compact form for tight spaces: 1.2K, 3.4M. */
export function formatCompact(paisa: number): string {
  const v = Math.abs(paisa) / 100;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(v));
}
