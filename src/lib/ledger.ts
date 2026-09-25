import type { Tx } from '@/db/queries';
import { addDays } from '@/lib/dates';
import { fromPaisa } from '@/lib/money';

/** Filtering, sorting and grouping for the "All entries" list. Pure functions so they are easy to test. */

export type TypeFilter = 'all' | 'expense' | 'income' | 'card';
export type Period = 'all' | 'cycle' | 'last' | '7d' | '30d';
export type Sort = 'newest' | 'oldest' | 'largest';

export type Filters = {
  type: TypeFilter;
  /** 'all', 'none' (expenses with no category) or a category id. Only expenses have a category. */
  category: 'all' | 'none' | number;
  /** 'all', 'none' (no bank named) or a bank id. */
  bank: 'all' | 'none' | number;
  period: Period;
  query: string;
  sort: Sort;
};

/** Nothing filtered: every entry, newest first. */
export const NO_FILTERS: Filters = {
  type: 'all',
  category: 'all',
  bank: 'all',
  period: 'all',
  query: '',
  sort: 'newest',
};

/** How many filters are narrowing the list (sorting doesn't narrow it). */
export function activeFilterCount(f: Filters): number {
  return [f.type !== 'all', f.category !== 'all', f.bank !== 'all', f.period !== 'all', f.query.trim() !== ''].filter(
    Boolean,
  ).length;
}

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
  const hay = [t.place, t.source, t.note, t.account_name, t.bank_name, fromPaisa(t.amount)]
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

    if (f.category !== 'all') {
      if (t.type !== 'expense') return false;
      if (f.category === 'none' ? t.account_id !== null : t.account_id !== f.category) return false;
    }
    if (f.bank !== 'all' && (f.bank === 'none' ? t.bank_id !== null : t.bank_id !== f.bank)) return false;

    if (f.period === 'cycle' && t.cycle_id !== ctx.currentCycleId) return false;
    if (f.period === 'last' && t.cycle_id !== ctx.lastCycleId) return false;
    if (f.period === '7d' && (t.date < from7 || t.date > ctx.today)) return false;
    if (f.period === '30d' && (t.date < from30 || t.date > ctx.today)) return false;

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
  let income = 0;
  for (const t of txs) {
    if (t.type === 'expense') expenses += t.amount;
    else if (t.type === 'income') income += t.amount;
  }
  return { count: txs.length, expenses, income };
}

export type DayGroup = { date: string; data: Tx[]; spent: number };

/** Consecutive entries on the same date, keeping the given order. */
export function groupByDate(txs: Tx[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const t of txs) {
    const last = groups[groups.length - 1];
    if (last && last.date === t.date) {
      last.data.push(t);
      if (t.type === 'expense') last.spent += t.amount;
    } else {
      groups.push({ date: t.date, data: [t], spent: t.type === 'expense' ? t.amount : 0 });
    }
  }
  return groups;
}
