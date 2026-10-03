import type { Tx } from '@/db/queries';
import { addDays } from '@/lib/dates';
import { fromPaisa } from '@/lib/money';

/** Filtering, sorting and grouping for the "All entries" list. Pure functions so they are easy to test. */

export type TypeFilter = 'all' | 'expense' | 'income' | 'card';
export type Period = 'all' | 'cycle' | 'last' | '7d' | '30d';
export type Sort = 'newest' | 'oldest' | 'largest';

export type Filters = {
  type: TypeFilter;
  /** Category ids to show; `NONE` stands for "no category". Empty = any. Only expenses have a category. */
  categories: number[];
  /** Bank ids to show; `NONE` stands for "no bank named". Empty = any. */
  banks: number[];
  period: Period;
  /** Tag ids; an entry needs at least one of them (empty = don't filter by tag). */
  tags: number[];
  query: string;
  sort: Sort;
};

/** Stands for "no category" / "no bank" inside `categories` and `banks`. */
export const NONE = 0;

/** Nothing filtered: every entry, newest first. */
export const NO_FILTERS: Filters = {
  type: 'all',
  categories: [],
  banks: [],
  period: 'all',
  tags: [],
  query: '',
  sort: 'newest',
};

/** How many filters are narrowing the list (sorting doesn't narrow it). */
export function activeFilterCount(f: Filters): number {
  return [
    f.type !== 'all',
    f.categories.length > 0,
    f.banks.length > 0,
    f.period !== 'all',
    f.tags.length > 0,
    f.query.trim() !== '',
  ].filter(Boolean).length;
}

/** What an entry costs you: an expense minus the part you paid on behalf of friends. */
export const myShare = (t: Tx): number => (t.type === 'expense' ? t.amount - t.shared : t.amount);

const isCardEntry = (t: Tx) => t.type === 'card_payment' || t.type === 'card_swipe' || t.type === 'card_withdrawal';

export type FilterContext = {
  today: string;
  currentCycleId: number | null;
  /** The cycle before the current one, if there is one. */
  lastCycleId: number | null;
};

function matchesQuery(t: Tx, query: string): boolean {
  // "2,300" and "2300" should both find an entry of Rs 2,300.
  const q = query.trim().toLowerCase().replace(/,/g, '');
  if (!q) return true;
  const hay = [t.place, t.source, t.note, t.account_name, t.bank_name, t.shared_with, t.tag_names, fromPaisa(t.amount)]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}

export function applyFilters(txs: Tx[], f: Filters, ctx: FilterContext): Tx[] {
  const from7 = addDays(ctx.today, -6);
  const from30 = addDays(ctx.today, -29);

  const rows = txs.filter((t) => {
    if (f.type === 'expense' && t.type !== 'expense') return false;
    if (f.type === 'income' && t.type !== 'income') return false;
    if (f.type === 'card' && !isCardEntry(t)) return false;

    if (f.categories.length) {
      if (t.type !== 'expense') return false;
      if (!f.categories.includes(t.account_id ?? NONE)) return false;
    }
    if (f.banks.length && !f.banks.includes(t.bank_id ?? NONE)) return false;

    if (f.period === 'cycle' && t.cycle_id !== ctx.currentCycleId) return false;
    if (f.period === 'last' && t.cycle_id !== ctx.lastCycleId) return false;
    if (f.period === '7d' && (t.date < from7 || t.date > ctx.today)) return false;
    if (f.period === '30d' && (t.date < from30 || t.date > ctx.today)) return false;

    if (f.tags.length) {
      const have = (t.tag_ids ?? '').split(',').filter(Boolean).map(Number);
      if (!f.tags.some((id) => have.includes(id))) return false;
    }

    return matchesQuery(t, f.query);
  });

  const byNewest = (a: Tx, b: Tx) => b.date.localeCompare(a.date) || b.id - a.id;
  if (f.sort === 'oldest') return rows.sort((a, b) => -byNewest(a, b));
  if (f.sort === 'largest') return rows.sort((a, b) => b.amount - a.amount || byNewest(a, b));
  return rows.sort(byNewest);
}

/** What the visible rows add up to. Card entries are transfers, so they are only counted, not summed. */
export function summarize(txs: Tx[]) {
  let expenses = 0;
  let paid = 0;
  let income = 0;
  for (const t of txs) {
    if (t.type === 'expense') {
      expenses += myShare(t);
      paid += t.amount;
    } else if (t.type === 'income') income += t.amount;
  }
  return { count: txs.length, expenses, paid, income };
}

export type DebtLike = { kind: 'lent' | 'borrowed' | 'got_back' | 'paid_back'; amount: number };

/** What happened with debts in a period: money you gave out, got back, borrowed and paid back. */
export function summarizeDebts(entries: DebtLike[]) {
  const t = { gave: 0, gotBack: 0, borrowed: 0, paidBack: 0 };
  for (const e of entries) {
    if (e.kind === 'lent') t.gave += e.amount;
    else if (e.kind === 'got_back') t.gotBack += e.amount;
    else if (e.kind === 'borrowed') t.borrowed += e.amount;
    else t.paidBack += e.amount;
  }
  return t;
}

export type DayGroup = { date: string; data: Tx[]; spent: number };

/** Consecutive entries on the same date, keeping the given order. */
export function groupByDate(txs: Tx[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const t of txs) {
    const last = groups[groups.length - 1];
    if (last && last.date === t.date) {
      last.data.push(t);
      if (t.type === 'expense') last.spent += myShare(t);
    } else {
      groups.push({ date: t.date, data: [t], spent: t.type === 'expense' ? myShare(t) : 0 });
    }
  }
  return groups;
}
