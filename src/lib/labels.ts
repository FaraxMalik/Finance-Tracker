import { withAlpha, type Palette } from '@/constants/theme';
import type { DebtKind } from '@/db/queries';

export const DEBT_LABEL: Record<DebtKind, string> = {
  lent: 'I lent',
  borrowed: 'I borrowed',
  got_back: 'They paid back',
  paid_back: 'I paid back',
};

/** Which way money moved for me: 'in' = it reached my pocket, 'out' = it left. Drives icon and colour. */
export const DEBT_FLOW: Record<DebtKind, 'in' | 'out'> = {
  lent: 'out',
  paid_back: 'out',
  borrowed: 'in',
  got_back: 'in',
};

export function balanceText(balance: number): string {
  if (balance > 0) return 'owes you';
  if (balance < 0) return 'you owe';
  return 'settled';
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/**
 * Colour for a category: fixed for the built-ins, a stable muted tone for ones the user adds.
 * Credit → Debit (`cardCash`) is a lighter shade of the card's colour: credit money, spent from a bank.
 */
export function categoryColor(
  name: string,
  kind: 'credit' | 'debit',
  colors: Palette,
  cardCash?: number | null,
): string {
  const key = name.trim().toLowerCase();
  if (cardCash) return withAlpha(colors.catCredit, 0.5);
  if (key === 'credit card' || kind === 'credit') return colors.catCredit;
  if (key === 'salary') return colors.catSalary;
  if (key === 'others' || key === 'uncategorised') return colors.catOthers;
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return colors.catExtra[hash % colors.catExtra.length];
}
