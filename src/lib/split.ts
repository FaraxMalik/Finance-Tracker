/** Dividing an expense you paid between you and the friends you paid for. All amounts are integer paisa. */

export type SplitMode = 'equal' | 'others' | 'custom';

export type Split = {
  /** Each friend's part, in the order given. */
  others: number[];
  /** What is left for you. Negative means the friends' parts add up to more than was paid. */
  mine: number;
};

/**
 * 'equal': you and the friends share it evenly (any odd paisa stays with you).
 * 'others': the friends split all of it and your part is zero.
 * 'custom': the given amounts; you keep the rest.
 */
export function splitExpense(total: number, count: number, mode: SplitMode, custom: number[] = []): Split {
  if (count <= 0) return { others: [], mine: total };
  if (mode === 'custom') {
    const others = Array.from({ length: count }, (_, i) => Math.max(custom[i] ?? 0, 0));
    return { others, mine: total - others.reduce((s, n) => s + n, 0) };
  }
  const parts = mode === 'equal' ? count + 1 : count;
  const base = Math.floor(total / parts);
  if (mode === 'equal') {
    const others = Array.from({ length: count }, () => base);
    return { others, mine: total - base * count };
  }
  const extra = total - base * count;
  return { others: Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0)), mine: 0 };
}
