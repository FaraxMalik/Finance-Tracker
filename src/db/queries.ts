import type { SQLiteDatabase } from 'expo-sqlite';

import {
  DEFAULT_CYCLE_START_DAY,
  ensureCardCashCategory,
  ensureQuickDefaults,
  moveLegacyAccountsToBanks,
} from '@/db/schema';
import { settleDebts, type DebtSide } from '@/db/settle';
import { todayISO } from '@/lib/dates';

export type { DebtSide } from '@/db/settle';

// ---------- Types ----------

export type AccountKind = 'credit' | 'debit';
/**
 * Card entries: a payment lowers what you owe. `card_swipe` is Credit → Debit (money moved off the card into a
 * bank, by swiping it on a machine): it raises what you owe but is not spending. Spending that money is a normal
 * expense filed under the Credit → Debit category. (Older data also had 'card_withdrawal'; the v8 upgrade turned
 * those into `card_swipe`.)
 */
export type TxType = 'expense' | 'income' | 'card_payment' | 'card_swipe';
/** How a card purchase was made: on a shop's machine ('pos') or online (null). */
export type Channel = 'pos' | null;
export type DebtKind = 'lent' | 'borrowed' | 'got_back' | 'paid_back';

/**
 * A spending category (Credit Card / Salary / Others / Credit → Debit / ...). `card_cash` = 1 marks Credit → Debit:
 * credit spending of money already moved off the card, so it never adds to what the card owes.
 */
export type Account = {
  id: number;
  name: string;
  kind: AccountKind;
  sort: number;
  archived: number;
  card_cash: number;
};

/** True for a category whose expenses are charged to the card (Online / POS purchases). */
export const chargedToCard = (a: { kind: AccountKind | null; card_cash?: number | null } | null | undefined) =>
  a?.kind === 'credit' && !a.card_cash;

/** SQL for an expense charged to the card, given the transaction and category aliases. */
const CARD_PURCHASE_SQL = (t: string, a: string) =>
  `${t}.type = 'expense' AND ${a}.kind = 'credit' AND ${a}.card_cash = 0`;

/** A saved shortcut for a common expense: pick it, type an amount, done. */
export type QuickExpense = {
  id: number;
  name: string;
  account_id: number | null;
  bank_id: number | null;
  sort: number;
  archived: number;
  account_name: string | null;
  account_kind: AccountKind | null;
  account_card_cash: number | null;
  bank_name: string | null;
};

/** A bank or wallet the money moved through (NayaPay, Meezan Bank, Cash, ...). */
export type Bank = { id: number; name: string; sort: number; archived: number };

export type Cycle = {
  id: number;
  start_date: string;
  end_date: string | null;
  closed_at: string | null;
  snap_card_owed: number | null;
  snap_owed_to_me: number | null;
  snap_i_owe: number | null;
};

export type Tx = {
  id: number;
  cycle_id: number;
  type: TxType;
  amount: number;
  fee: number;
  date: string;
  account_id: number | null;
  bank_id: number | null;
  place: string | null;
  source: string | null;
  note: string | null;
  created_at: string;
  channel: Channel;
  account_name: string | null;
  account_kind: AccountKind | null;
  account_card_cash: number | null;
  bank_name: string | null;
  /** Part of `amount` you paid on behalf of others; it sits in their debts, not in your spending. */
  shared: number;
  shared_with: string | null;
  /** Comma-separated ids and names of this entry's tags (same order), or null. */
  tag_ids: string | null;
  tag_names: string | null;
};

export type Tag = { id: number; name: string; sort: number };

/** One friend's part of an expense you paid. */
export type Share = { person_id: number; amount: number };
export type ShareRow = Share & { name: string };

export type TxInput = {
  type: TxType;
  amount: number;
  date: string;
  /** Only for a card purchase: 'pos' or null (online). */
  channel?: Channel;
  /** Spending category; only expenses have one. */
  account_id?: number | null;
  /** Bank the money was paid from / received in. */
  bank_id?: number | null;
  place?: string | null;
  source?: string | null;
  note?: string | null;
  /**
   * Friends whose part of an expense you paid. Saved as "I lent" entries, so they owe you that much.
   * Omit to leave the existing ones alone on an update; an empty list removes them.
   */
  shares?: Share[];
  /** Tag ids. Omit to leave the existing tags alone on an update; an empty list removes them. */
  tags?: number[];
};

/** Spending for one category (account) in a cycle. `id` is null for entries with no category. */
export type CategoryTotal = { id: number | null; name: string; kind: AccountKind; card_cash: number; total: number };

/** Spending paid from one bank in a cycle. */
export type BankTotal = { id: number; name: string; total: number };

export type CycleTotals = {
  /** Spending per bank (entries with a bank only). Not every expense names a bank, so this may be less than the total. */
  banks: BankTotal[];
  /** Per-category spending; always sums to `totalSpent`. Empty categories are left out. */
  breakdown: CategoryTotal[];
  debitSpent: number;
  creditSpent: number;
  /** Your own spending: everything you paid except what you paid on behalf of others. */
  totalSpent: number;
  /** What you paid for others, which you expect to get back. */
  sharedOut: number;
  /** All the money that went out: your spending plus what you paid for others. */
  totalPaid: number;
  income: number;
  /** Money moved off the card into a bank this cycle. Not income; Home can show it beside income. */
  creditToDebit: number;
  cardPayments: number;
};

/**
 * `they_owe` and `i_owe` are two separate, independent running totals — what they owe you (lent minus got back)
 * and what you owe them (borrowed minus paid back) — each never less than zero and each settled on its own.
 * `balance` is just their net (`they_owe - i_owe`), shown as one figure but not used to decide anything.
 * `they_settled_on` / `i_settled_on` is the day each side last came out square (null if never).
 */
export type Person = {
  id: number;
  name: string;
  balance: number;
  they_owe: number;
  i_owe: number;
  they_settled_on: string | null;
  i_settled_on: string | null;
};
export type DebtEntry = {
  id: number;
  person_id: number;
  kind: DebtKind;
  amount: number;
  date: string;
  note: string | null;
  /** Set when the entry is a friend's share of an expense; the expense owns it. */
  tx_id: number | null;
  /** Set once the entry is part of a settled (squared-up) stretch with this person. */
  settlement_id: number | null;
};

/** A stretch of one side of a person's entries that ended square, newest first in listings. */
export type Settlement = {
  id: number;
  person_id: number;
  side: DebtSide;
  settled_on: string;
  count: number;
  lent: number;
  got_back: number;
  borrowed: number;
  paid_back: number;
};

// ---------- Settings ----------

export async function getSetting(db: SQLiteDatabase, key: string): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  return row?.value ?? null;
}

export async function setSetting(db: SQLiteDatabase, key: string, value: string) {
  await db.runAsync(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value,
  );
}

export async function getNumberSetting(db: SQLiteDatabase, key: string, fallback = 0): Promise<number> {
  const v = await getSetting(db, key);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const getCycleStartDay = (db: SQLiteDatabase) =>
  getNumberSetting(db, 'cycle_start_day', DEFAULT_CYCLE_START_DAY);

// ---------- Accounts ----------

export function listAccounts(db: SQLiteDatabase, includeArchived = false) {
  return db.getAllAsync<Account>(
    `SELECT * FROM accounts ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY sort, id`,
  );
}

export async function addAccount(db: SQLiteDatabase, name: string, kind: AccountKind) {
  const row = await db.getFirstAsync<{ next: number }>('SELECT COALESCE(MAX(sort), -1) + 1 AS next FROM accounts');
  await db.runAsync('INSERT INTO accounts (name, kind, sort) VALUES (?, ?, ?)', name, kind, row?.next ?? 0);
}

export async function updateAccount(db: SQLiteDatabase, id: number, name: string, kind: AccountKind) {
  await db.runAsync('UPDATE accounts SET name = ?, kind = ? WHERE id = ?', name, kind, id);
}

/** Accounts with history are archived rather than deleted so old reports stay intact. */
export async function archiveAccount(db: SQLiteDatabase, id: number) {
  await db.runAsync('UPDATE accounts SET archived = 1 WHERE id = ?', id);
}

// ---------- Banks ----------

export function listBanks(db: SQLiteDatabase, includeArchived = false) {
  return db.getAllAsync<Bank>(`SELECT * FROM banks ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY sort, id`);
}

export async function addBank(db: SQLiteDatabase, name: string) {
  const row = await db.getFirstAsync<{ next: number }>('SELECT COALESCE(MAX(sort), -1) + 1 AS next FROM banks');
  await db.runAsync('INSERT INTO banks (name, sort) VALUES (?, ?)', name, row?.next ?? 0);
}

export async function renameBank(db: SQLiteDatabase, id: number, name: string) {
  await db.runAsync('UPDATE banks SET name = ? WHERE id = ?', name, id);
}

/** Hidden rather than deleted so old entries keep their bank name. */
export async function archiveBank(db: SQLiteDatabase, id: number) {
  await db.runAsync('UPDATE banks SET archived = 1 WHERE id = ?', id);
}

// ---------- Quick add ----------

const QUICK_SELECT = `
  SELECT q.*, a.name AS account_name, a.kind AS account_kind, a.card_cash AS account_card_cash, b.name AS bank_name
  FROM quick_expenses q
  LEFT JOIN accounts a ON a.id = q.account_id
  LEFT JOIN banks b ON b.id = q.bank_id`;

export function listQuick(db: SQLiteDatabase) {
  return db.getAllAsync<QuickExpense>(`${QUICK_SELECT} WHERE q.archived = 0 ORDER BY q.sort, q.id`);
}

export function getQuick(db: SQLiteDatabase, id: number) {
  return db.getFirstAsync<QuickExpense>(`${QUICK_SELECT} WHERE q.id = ?`, id);
}

export async function addQuick(db: SQLiteDatabase, name: string, accountId: number | null, bankId: number | null) {
  const row = await db.getFirstAsync<{ next: number }>(
    'SELECT COALESCE(MAX(sort), -1) + 1 AS next FROM quick_expenses',
  );
  await db.runAsync(
    'INSERT INTO quick_expenses (name, account_id, bank_id, sort) VALUES (?, ?, ?, ?)',
    name,
    accountId,
    bankId,
    row?.next ?? 0,
  );
}

export async function updateQuick(
  db: SQLiteDatabase,
  id: number,
  name: string,
  accountId: number | null,
  bankId: number | null,
) {
  await db.runAsync(
    'UPDATE quick_expenses SET name = ?, account_id = ?, bank_id = ? WHERE id = ?',
    name,
    accountId,
    bankId,
    id,
  );
}

/** Entries already saved keep their text; the shortcut just stops being offered. */
export async function archiveQuick(db: SQLiteDatabase, id: number) {
  await db.runAsync('UPDATE quick_expenses SET archived = 1 WHERE id = ?', id);
}

// ---------- Tags ----------

export function listTags(db: SQLiteDatabase) {
  return db.getAllAsync<Tag>('SELECT * FROM tags ORDER BY sort, id');
}

/** Returns the id of the tag with this name (any capitalisation), creating it if needed. */
export async function findOrCreateTag(db: SQLiteDatabase, name: string): Promise<number> {
  const trimmed = name.trim().replace(/,/g, ' ');
  const existing = await db.getFirstAsync<{ id: number }>('SELECT id FROM tags WHERE name = ? COLLATE NOCASE', trimmed);
  if (existing) return existing.id;
  const row = await db.getFirstAsync<{ next: number }>('SELECT COALESCE(MAX(sort), -1) + 1 AS next FROM tags');
  const res = await db.runAsync('INSERT INTO tags (name, sort) VALUES (?, ?)', trimmed, row?.next ?? 0);
  return res.lastInsertRowId;
}

/** Removes the tag from every entry; the entries themselves stay. */
export async function deleteTag(db: SQLiteDatabase, id: number) {
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM tx_tags WHERE tag_id = ?', id);
    await db.runAsync('DELETE FROM tags WHERE id = ?', id);
  });
}

/** Moves several expenses to another category (or to none). Entries that are not expenses are left alone. */
export async function setCategoryOnTransactions(db: SQLiteDatabase, txIds: number[], accountId: number | null) {
  await db.withTransactionAsync(async () => {
    for (const txId of txIds) {
      await db.runAsync("UPDATE transactions SET account_id = ? WHERE id = ? AND type = 'expense'", accountId, txId);
    }
  });
}

/** Adds (`on`) or removes a tag on several entries at once. */
export async function setTagOnTransactions(db: SQLiteDatabase, txIds: number[], tagId: number, on: boolean) {
  await db.withTransactionAsync(async () => {
    for (const txId of txIds) {
      if (on) await db.runAsync('INSERT OR IGNORE INTO tx_tags (tx_id, tag_id) VALUES (?, ?)', txId, tagId);
      else await db.runAsync('DELETE FROM tx_tags WHERE tx_id = ? AND tag_id = ?', txId, tagId);
    }
  });
}

export type TagTotal = { id: number; name: string; count: number; paid: number; mine: number };

/** Expenses carrying each tag in a cycle: what you paid, and your own share of it. Tags with no expenses are left out. */
export function getTagTotals(db: SQLiteDatabase, cycleId: number) {
  return db.getAllAsync<TagTotal>(
    `SELECT g.id, g.name, COUNT(*) AS count, SUM(t.amount) AS paid, SUM(${MINE_SQL('t')}) AS mine
     FROM tags g
     JOIN tx_tags tt ON tt.tag_id = g.id
     JOIN transactions t ON t.id = tt.tx_id AND t.cycle_id = ? AND t.type = 'expense'
     GROUP BY g.id ORDER BY g.sort, g.id`,
    cycleId,
  );
}

// ---------- Cycles ----------

export function getActiveCycle(db: SQLiteDatabase) {
  return db.getFirstAsync<Cycle>('SELECT * FROM cycles WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1');
}

export function getCycle(db: SQLiteDatabase, id: number) {
  return db.getFirstAsync<Cycle>('SELECT * FROM cycles WHERE id = ?', id);
}

/** Closes the active cycle with a snapshot of the running balances, then opens a fresh one today. */
export async function startNewCycle(db: SQLiteDatabase) {
  await db.withTransactionAsync(async () => {
    const active = await getActiveCycle(db);
    if (!active) return;
    const card = await getCardSummary(db, active.id);
    const debts = await getDebtTotals(db);
    const today = todayISO();
    await db.runAsync(
      `UPDATE cycles SET end_date = ?, closed_at = ?, snap_card_owed = ?, snap_owed_to_me = ?, snap_i_owe = ?
       WHERE id = ?`,
      today,
      new Date().toISOString(),
      card.owed,
      debts.owedToMe,
      debts.iOwe,
      active.id,
    );
    await db.runAsync('INSERT INTO cycles (start_date) VALUES (?)', today);
  });
}

export type ClosedCycle = Cycle & CycleTotals;

export async function listClosedCycles(db: SQLiteDatabase): Promise<ClosedCycle[]> {
  const cycles = await db.getAllAsync<Cycle>('SELECT * FROM cycles WHERE closed_at IS NOT NULL ORDER BY id DESC');
  const out: ClosedCycle[] = [];
  for (const c of cycles) out.push({ ...c, ...(await getCycleTotals(db, c.id)) });
  return out;
}

// ---------- Transactions ----------

/** What you paid on behalf of others for an expense (their shares are linked debt entries). */
const SHARED_SQL = (t: string) => `COALESCE((SELECT SUM(d.amount) FROM debt_entries d WHERE d.tx_id = ${t}.id), 0)`;
/** Your own part of an expense: everything except what you paid for others. */
const MINE_SQL = (t: string) => `(${t}.amount - ${SHARED_SQL(t)})`;

const TX_SELECT = `
  SELECT t.*, a.name AS account_name, a.kind AS account_kind, a.card_cash AS account_card_cash, b.name AS bank_name,
    ${SHARED_SQL('t')} AS shared,
    (SELECT GROUP_CONCAT(name, ', ') FROM
      (SELECT p.name AS name FROM debt_entries d JOIN people p ON p.id = d.person_id
       WHERE d.tx_id = t.id ORDER BY d.id)) AS shared_with,
    (SELECT GROUP_CONCAT(tag_id) FROM (SELECT tt.tag_id FROM tx_tags tt WHERE tt.tx_id = t.id ORDER BY tt.tag_id)) AS tag_ids,
    (SELECT GROUP_CONCAT(name, ', ') FROM
      (SELECT g.name AS name FROM tx_tags tt JOIN tags g ON g.id = tt.tag_id
       WHERE tt.tx_id = t.id ORDER BY tt.tag_id)) AS tag_names
  FROM transactions t
  LEFT JOIN accounts a ON a.id = t.account_id
  LEFT JOIN banks b ON b.id = t.bank_id`;

/** Every entry of a cycle, Credit → Debit moves included, newest first. */
export function listTransactions(db: SQLiteDatabase, cycleId: number) {
  return db.getAllAsync<Tx>(`${TX_SELECT} WHERE t.cycle_id = ? ORDER BY t.date DESC, t.id DESC`, cycleId);
}

/**
 * The latest entries of a cycle for Home. Credit → Debit moves are left out: they are not spending, and they
 * live on the Credit screen.
 */
export function listRecentTransactions(db: SQLiteDatabase, cycleId: number, limit: number) {
  return db.getAllAsync<Tx>(
    `${TX_SELECT} WHERE t.cycle_id = ? AND t.type != 'card_swipe' ORDER BY t.date DESC, t.id DESC LIMIT ?`,
    cycleId,
    Math.floor(limit),
  );
}

/** Every entry across all cycles, newest first. */
export function listAllTransactions(db: SQLiteDatabase) {
  return db.getAllAsync<Tx>(`${TX_SELECT} ORDER BY t.date DESC, t.id DESC`);
}

/**
 * All cycles, newest first (the active one, then closed ones). Ordered by start_date rather than id:
 * cycles are normally created in chronological order so the two agree, but a restored backup or other
 * out-of-order insert could give a cycle a lower id than one that starts earlier, and start_date is
 * what actually defines "current" vs "last" here.
 */
export function listCycles(db: SQLiteDatabase) {
  return db.getAllAsync<Cycle>('SELECT * FROM cycles ORDER BY start_date DESC, id DESC');
}

export function listCardTransactions(db: SQLiteDatabase, cycleId: number) {
  return db.getAllAsync<Tx>(
    `${TX_SELECT}
     WHERE t.cycle_id = ? AND (t.type IN ('card_payment', 'card_swipe') OR (${CARD_PURCHASE_SQL('t', 'a')}))
     ORDER BY t.date DESC, t.id DESC`,
    cycleId,
  );
}

export function getTransaction(db: SQLiteDatabase, id: number) {
  return db.getFirstAsync<Tx>(`${TX_SELECT} WHERE t.id = ?`, id);
}

const clean = (s?: string | null) => (s && s.trim() ? s.trim() : null);

/**
 * Entries whose money can be paid on behalf of friends. New shares go on expenses; a Credit → Debit move keeps any
 * shares it was saved with before it stopped counting as spending.
 */
const SHAREABLE: TxType[] = ['expense', 'card_swipe'];

/** Replaces the friends' shares of an expense; each becomes an "I lent" entry on the expense's date. */
async function saveShares(db: SQLiteDatabase, txId: number, tx: TxInput) {
  const before = await db.getAllAsync<{ person_id: number }>(
    'SELECT person_id FROM debt_entries WHERE tx_id = ?',
    txId,
  );
  await db.runAsync('DELETE FROM debt_entries WHERE tx_id = ?', txId);
  const shares = SHAREABLE.includes(tx.type) ? (tx.shares ?? []).filter((s) => s.amount > 0) : [];
  if (shares.reduce((sum, s) => sum + s.amount, 0) > tx.amount) {
    throw new Error('The shares add up to more than the amount paid.');
  }
  const note = clean(tx.place) ?? 'Shared expense';
  for (const s of shares) {
    await db.runAsync(
      `INSERT INTO debt_entries (person_id, kind, amount, date, note, created_at, tx_id)
       VALUES (?, 'lent', ?, ?, ?, ?, ?)`,
      s.person_id,
      s.amount,
      tx.date,
      note,
      new Date().toISOString(),
      txId,
    );
  }
  await settleDebts(db, [...before.map((b) => b.person_id), ...shares.map((s) => s.person_id)]);
}

async function saveTags(db: SQLiteDatabase, txId: number, tagIds: number[]) {
  await db.runAsync('DELETE FROM tx_tags WHERE tx_id = ?', txId);
  for (const tagId of new Set(tagIds)) {
    await db.runAsync('INSERT INTO tx_tags (tx_id, tag_id) VALUES (?, ?)', txId, tagId);
  }
}

export async function addTransaction(db: SQLiteDatabase, cycleId: number, tx: TxInput): Promise<number> {
  let id = 0;
  await db.withTransactionAsync(async () => {
    const res = await db.runAsync(
      `INSERT INTO transactions (cycle_id, type, amount, date, channel, account_id, bank_id, place, source, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      cycleId,
      tx.type,
      tx.amount,
      tx.date,
      tx.channel ?? null,
      tx.account_id ?? null,
      tx.bank_id ?? null,
      clean(tx.place),
      clean(tx.source),
      clean(tx.note),
      new Date().toISOString(),
    );
    id = res.lastInsertRowId;
    if (tx.shares?.length) await saveShares(db, id, tx);
    if (tx.tags?.length) await saveTags(db, id, tx.tags);
  });
  return id;
}

export async function updateTransaction(db: SQLiteDatabase, id: number, tx: TxInput) {
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `UPDATE transactions SET type = ?, amount = ?, fee = 0, date = ?, channel = ?, account_id = ?, bank_id = ?, place = ?, source = ?, note = ?
       WHERE id = ?`,
      tx.type,
      tx.amount,
      tx.date,
      tx.channel ?? null,
      tx.account_id ?? null,
      tx.bank_id ?? null,
      clean(tx.place),
      clean(tx.source),
      clean(tx.note),
      id,
    );
    if (tx.shares !== undefined || !SHAREABLE.includes(tx.type)) await saveShares(db, id, tx);
    if (tx.tags !== undefined) await saveTags(db, id, tx.tags);
  });
}

/** The friends an expense was paid for, in the order they were added. */
export function listShares(db: SQLiteDatabase, txId: number) {
  return db.getAllAsync<ShareRow>(
    `SELECT d.person_id, p.name, d.amount FROM debt_entries d JOIN people p ON p.id = d.person_id
     WHERE d.tx_id = ? ORDER BY d.id`,
    txId,
  );
}

export async function deleteTransaction(db: SQLiteDatabase, id: number) {
  await db.withTransactionAsync(async () => {
    const people = await db.getAllAsync<{ person_id: number }>(
      'SELECT person_id FROM debt_entries WHERE tx_id = ?',
      id,
    );
    await db.runAsync('DELETE FROM debt_entries WHERE tx_id = ?', id);
    await db.runAsync('DELETE FROM tx_tags WHERE tx_id = ?', id);
    await db.runAsync('DELETE FROM transactions WHERE id = ?', id);
    await settleDebts(
      db,
      people.map((p) => p.person_id),
    );
  });
}

/**
 * Spending rules:
 *  - expense in a credit category (Credit Card, Credit → Debit) -> credit spent; any other (or none) -> debit spent
 *  - income, card payments and Credit → Debit moves are not spending (fees are not tracked; older ones are ignored)
 */
export async function getCycleTotals(db: SQLiteDatabase, cycleId: number): Promise<CycleTotals> {
  const row = await db.getFirstAsync<{
    debit: number;
    credit: number;
    income: number;
    moved: number;
    payments: number;
    shared: number;
  }>(
    `SELECT
       COALESCE(SUM(CASE WHEN t.type = 'expense' AND COALESCE(a.kind, 'debit') = 'debit' THEN ${MINE_SQL('t')} END), 0) AS debit,
       COALESCE(SUM(CASE WHEN t.type = 'expense' AND a.kind = 'credit' THEN ${MINE_SQL('t')} END), 0) AS credit,
       COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount END), 0) AS income,
       COALESCE(SUM(CASE WHEN t.type = 'card_swipe' THEN t.amount END), 0) AS moved,
       COALESCE(SUM(CASE WHEN t.type = 'card_payment' THEN t.amount END), 0) AS payments,
       COALESCE(SUM(CASE WHEN t.type = 'expense' THEN ${SHARED_SQL('t')} END), 0) AS shared
     FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.cycle_id = ?`,
    cycleId,
  );
  const debitSpent = row?.debit ?? 0;
  const creditSpent = row?.credit ?? 0;
  return {
    breakdown: await getBreakdown(db, cycleId),
    banks: await getBankTotals(db, cycleId),
    debitSpent,
    creditSpent,
    totalSpent: debitSpent + creditSpent,
    sharedOut: row?.shared ?? 0,
    totalPaid: debitSpent + creditSpent + (row?.shared ?? 0),
    income: row?.income ?? 0,
    creditToDebit: row?.moved ?? 0,
    cardPayments: row?.payments ?? 0,
  };
}

/** Expenses paid from each bank, largest first. */
async function getBankTotals(db: SQLiteDatabase, cycleId: number): Promise<BankTotal[]> {
  return db.getAllAsync<BankTotal>(
    `SELECT b.id, b.name, SUM(${MINE_SQL('t')}) AS total
     FROM transactions t JOIN banks b ON b.id = t.bank_id
     WHERE t.cycle_id = ? AND t.type = 'expense'
     GROUP BY b.id HAVING total > 0 ORDER BY total DESC, b.name`,
    cycleId,
  );
}

/** One row per category with spending, in the order the categories are set up. */
async function getBreakdown(db: SQLiteDatabase, cycleId: number): Promise<CategoryTotal[]> {
  const rows = await db.getAllAsync<CategoryTotal>(
    `SELECT a.id, a.name, a.kind, a.card_cash, COALESCE(SUM(${MINE_SQL('t')}), 0) AS total
     FROM accounts a
     LEFT JOIN transactions t ON t.account_id = a.id AND t.cycle_id = ? AND t.type = 'expense'
     GROUP BY a.id ORDER BY a.sort, a.id`,
    cycleId,
  );
  const none = await db.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(${MINE_SQL('transactions')}), 0) AS total FROM transactions
     WHERE cycle_id = ? AND type = 'expense' AND account_id IS NULL`,
    cycleId,
  );

  const list = [...rows];
  const uncategorised = none?.total ?? 0;
  if (uncategorised > 0)
    list.push({ id: null, name: 'Uncategorised', kind: 'debit', card_cash: 0, total: uncategorised });

  return list.filter((c) => c.total > 0);
}

/** Spending per day (your share of expenses) for the bar chart. */
export function getDailySpend(db: SQLiteDatabase, cycleId: number) {
  return db.getAllAsync<{ date: string; total: number }>(
    `SELECT date, SUM(${MINE_SQL('transactions')}) AS total
     FROM transactions WHERE cycle_id = ? AND type = 'expense' GROUP BY date HAVING total > 0 ORDER BY date`,
    cycleId,
  );
}

// ---------- Credit card ----------

export type CardSummary = {
  limit: number;
  owed: number;
  available: number;
  usedFraction: number;
  /** This cycle's purchases on the card at a shop's machine. */
  pos: number;
  /**
   * This cycle's purchases on the card online. A purchase entered on Home under the Credit Card category is the
   * same thing, so it is counted here (or under POS).
   */
  online: number;
  /** Money moved off the card into a bank this cycle. */
  creditToDebit: number;
  /** What was spent this cycle under the Credit → Debit category (full amounts, friends' shares included). */
  creditToDebitSpent: number;
  payments: number;
};

/** Card owed is all-time: opening balance + POS and online purchases + Credit → Debit moves - bill payments. */
export async function getCardSummary(db: SQLiteDatabase, cycleId: number): Promise<CardSummary> {
  const limit = await getNumberSetting(db, 'credit_limit');
  const opening = await getNumberSetting(db, 'card_opening_balance');
  const all = await db.getFirstAsync<{ purchases: number; moved: number; payments: number }>(
    `SELECT
       COALESCE(SUM(CASE WHEN ${CARD_PURCHASE_SQL('t', 'a')} THEN t.amount END), 0) AS purchases,
       COALESCE(SUM(CASE WHEN t.type = 'card_swipe' THEN t.amount END), 0) AS moved,
       COALESCE(SUM(CASE WHEN t.type = 'card_payment' THEN t.amount END), 0) AS payments
     FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id`,
  );
  const owed = opening + (all?.purchases ?? 0) + (all?.moved ?? 0) - (all?.payments ?? 0);
  const cycle = await db.getFirstAsync<Omit<CardSummary, 'limit' | 'owed' | 'available' | 'usedFraction'>>(
    `SELECT
       COALESCE(SUM(CASE WHEN ${CARD_PURCHASE_SQL('t', 'a')} AND t.channel = 'pos' THEN t.amount END), 0) AS pos,
       COALESCE(SUM(CASE WHEN ${CARD_PURCHASE_SQL('t', 'a')} AND t.channel IS NULL THEN t.amount END), 0) AS online,
       COALESCE(SUM(CASE WHEN t.type = 'card_swipe' THEN t.amount END), 0) AS creditToDebit,
       COALESCE(SUM(CASE WHEN t.type = 'expense' AND a.card_cash = 1 THEN t.amount END), 0) AS creditToDebitSpent,
       COALESCE(SUM(CASE WHEN t.type = 'card_payment' THEN t.amount END), 0) AS payments
     FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.cycle_id = ?`,
    cycleId,
  );
  return {
    limit,
    owed,
    available: limit - owed,
    usedFraction: limit > 0 ? Math.min(Math.max(owed / limit, 0), 1) : 0,
    pos: cycle?.pos ?? 0,
    online: cycle?.online ?? 0,
    creditToDebit: cycle?.creditToDebit ?? 0,
    creditToDebitSpent: cycle?.creditToDebitSpent ?? 0,
    payments: cycle?.payments ?? 0,
  };
}

// ---------- People & debts ----------

/**
 * Each side is its own gross total over its still-open entries, never below zero: what they owe you from
 * lent/got_back, and what you owe them from borrowed/paid_back, completely independent of each other.
 */
const PERSON_SQL = `SELECT p.id, p.name,
       MAX(COALESCE(SUM(CASE WHEN d.settlement_id IS NULL THEN CASE d.kind WHEN 'lent' THEN d.amount WHEN 'got_back' THEN -d.amount ELSE 0 END END), 0), 0) AS they_owe,
       MAX(COALESCE(SUM(CASE WHEN d.settlement_id IS NULL THEN CASE d.kind WHEN 'borrowed' THEN d.amount WHEN 'paid_back' THEN -d.amount ELSE 0 END END), 0), 0) AS i_owe,
       (SELECT MAX(s.settled_on) FROM debt_settlements s WHERE s.person_id = p.id AND s.side = 'they') AS they_settled_on,
       (SELECT MAX(s.settled_on) FROM debt_settlements s WHERE s.person_id = p.id AND s.side = 'me') AS i_settled_on
     FROM people p LEFT JOIN debt_entries d ON d.person_id = p.id`;

const withBalance = (p: Person): Person => ({ ...p, balance: p.they_owe - p.i_owe });

export async function listPeople(db: SQLiteDatabase) {
  const rows = await db.getAllAsync<Person>(
    `${PERSON_SQL} GROUP BY p.id ORDER BY they_owe + i_owe DESC, p.name COLLATE NOCASE`,
  );
  return rows.map(withBalance);
}

/** Sums each side across everyone, so these always match what the Debts list adds up to on each tab. */
export async function getDebtTotals(db: SQLiteDatabase) {
  const people = await listPeople(db);
  const owedToMe = people.reduce((s, p) => s + p.they_owe, 0);
  const iOwe = people.reduce((s, p) => s + p.i_owe, 0);
  return { owedToMe, iOwe, net: owedToMe - iOwe };
}

export async function getPerson(db: SQLiteDatabase, id: number) {
  const row = await db.getFirstAsync<Person>(`${PERSON_SQL} WHERE p.id = ? GROUP BY p.id`, id);
  return row ? withBalance(row) : null;
}

/** Every entry with a person, open and settled, newest first. */
export function listDebtEntries(db: SQLiteDatabase, personId: number) {
  return db.getAllAsync<DebtEntry>(
    'SELECT id, person_id, kind, amount, date, note, tx_id, settlement_id FROM debt_entries WHERE person_id = ? ORDER BY date DESC, id DESC',
    personId,
  );
}

/** The stretches that ended square with a person, newest first, with what moved each way. */
export function listSettlements(db: SQLiteDatabase, personId: number) {
  return db.getAllAsync<Settlement>(
    `SELECT s.id, s.person_id, s.side, s.settled_on, COUNT(d.id) AS count,
       COALESCE(SUM(CASE WHEN d.kind = 'lent' THEN d.amount END), 0) AS lent,
       COALESCE(SUM(CASE WHEN d.kind = 'got_back' THEN d.amount END), 0) AS got_back,
       COALESCE(SUM(CASE WHEN d.kind = 'borrowed' THEN d.amount END), 0) AS borrowed,
       COALESCE(SUM(CASE WHEN d.kind = 'paid_back' THEN d.amount END), 0) AS paid_back
     FROM debt_settlements s LEFT JOIN debt_entries d ON d.settlement_id = s.id
     WHERE s.person_id = ?
     GROUP BY s.id ORDER BY s.settled_on DESC, s.id DESC`,
    personId,
  );
}

export type CycleDebtEntry = DebtEntry & { person_name: string };

/**
 * Debt entries that belong to a cycle. A friend's share of an expense belongs to the cycle of that expense;
 * a plain entry belongs to the cycle whose dates it falls in (a closed cycle ends where the next one starts).
 */
export function listDebtEntriesForCycle(db: SQLiteDatabase, cycle: Cycle) {
  return db.getAllAsync<CycleDebtEntry>(
    `SELECT d.id, d.person_id, d.kind, d.amount, d.date, d.note, d.tx_id, d.settlement_id, p.name AS person_name
     FROM debt_entries d
     JOIN people p ON p.id = d.person_id
     LEFT JOIN transactions t ON t.id = d.tx_id
     WHERE (d.tx_id IS NOT NULL AND t.cycle_id = ?)
        OR (d.tx_id IS NULL AND d.date >= ? AND (? IS NULL OR d.date < ?))
     ORDER BY d.date DESC, d.id DESC`,
    cycle.id,
    cycle.start_date,
    cycle.end_date,
    cycle.end_date,
  );
}

export async function findOrCreatePerson(db: SQLiteDatabase, name: string): Promise<number> {
  const trimmed = name.trim();
  const existing = await db.getFirstAsync<{ id: number }>(
    'SELECT id FROM people WHERE name = ? COLLATE NOCASE',
    trimmed,
  );
  if (existing) return existing.id;
  const res = await db.runAsync('INSERT INTO people (name) VALUES (?)', trimmed);
  return res.lastInsertRowId;
}

export async function addDebtEntry(
  db: SQLiteDatabase,
  personId: number,
  kind: DebtKind,
  amount: number,
  date: string,
  note?: string | null,
) {
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      'INSERT INTO debt_entries (person_id, kind, amount, date, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      personId,
      kind,
      amount,
      date,
      clean(note),
      new Date().toISOString(),
    );
    await settleDebts(db, [personId]);
  });
}

/**
 * Squares up one side with a person: records the payment that brings it to zero (they paid you back the `'they'`
 * side, or you paid them back the `'me'` side), dated `date`. Only that side's history settles; the other side, if
 * any, is untouched. Returns the entry it recorded, or null if that side was already at zero.
 */
export async function settleUp(db: SQLiteDatabase, personId: number, side: DebtSide, date: string = todayISO()) {
  let recorded: { kind: DebtKind; amount: number } | null = null;
  await db.withTransactionAsync(async () => {
    const [upKind, downKind]: [DebtKind, DebtKind] = side === 'they' ? ['lent', 'got_back'] : ['borrowed', 'paid_back'];
    const rows = await db.getAllAsync<{ kind: DebtKind; amount: number }>(
      'SELECT kind, amount FROM debt_entries WHERE person_id = ? AND settlement_id IS NULL AND kind IN (?, ?)',
      personId,
      upKind,
      downKind,
    );
    const open = rows.reduce((sum, r) => sum + (r.kind === upKind ? r.amount : -r.amount), 0);
    if (open <= 0) return;
    const kind = side === 'they' ? 'got_back' : 'paid_back';
    recorded = { kind, amount: open };
    await db.runAsync(
      'INSERT INTO debt_entries (person_id, kind, amount, date, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      personId,
      kind,
      open,
      date,
      'Settled up',
      new Date().toISOString(),
    );
    await settleDebts(db, [personId]);
  });
  return recorded as { kind: DebtKind; amount: number } | null;
}

export async function deleteDebtEntry(db: SQLiteDatabase, id: number) {
  await db.withTransactionAsync(async () => {
    const entry = await db.getFirstAsync<{ person_id: number }>('SELECT person_id FROM debt_entries WHERE id = ?', id);
    await db.runAsync('DELETE FROM debt_entries WHERE id = ?', id);
    if (entry) await settleDebts(db, [entry.person_id]);
  });
}

export async function deletePerson(db: SQLiteDatabase, id: number) {
  await db.runAsync('DELETE FROM people WHERE id = ?', id);
}

// ---------- Backup / restore ----------

/** Column whitelists keep restore safe even if a backup file was hand-edited. */
const BACKUP_TABLES = {
  settings: ['key', 'value'],
  accounts: ['id', 'name', 'kind', 'sort', 'archived', 'card_cash'],
  banks: ['id', 'name', 'sort', 'archived'],
  quick_expenses: ['id', 'name', 'account_id', 'bank_id', 'sort', 'archived'],
  cycles: ['id', 'start_date', 'end_date', 'closed_at', 'snap_card_owed', 'snap_owed_to_me', 'snap_i_owe'],
  transactions: [
    'id',
    'cycle_id',
    'type',
    'amount',
    'fee',
    'date',
    'channel',
    'account_id',
    'bank_id',
    'place',
    'source',
    'note',
    'created_at',
  ],
  people: ['id', 'name'],
  tags: ['id', 'name', 'sort'],
  tx_tags: ['tx_id', 'tag_id'],
  debt_settlements: ['id', 'person_id', 'side', 'settled_on', 'created_at'],
  debt_entries: ['id', 'person_id', 'kind', 'amount', 'date', 'note', 'created_at', 'tx_id', 'settlement_id'],
} as const;

/** Delete children before parents, insert parents before children. */
const RESTORE_ORDER = [
  'tx_tags',
  'debt_entries',
  'debt_settlements',
  'transactions',
  'quick_expenses',
  'people',
  'cycles',
  'accounts',
  'banks',
  'tags',
  'settings',
] as const;

/** Columns an older backup does not have, and what they start as (restoring always rebuilds settlements anyway). */
const COLUMN_DEFAULTS: Record<string, string | number | null> = { card_cash: 0, side: 'they' };

/**
 * Version 2 added banks, 3 quick-adds, 4 tags, 5 POS purchases and the Credit → Debit category, 6 settled debt
 * history, 7 settling each side on its own. Older backups still restore.
 */
export type Backup = { app: 'finance-tracker'; version: 1 | 2 | 3 | 4 | 5 | 6 | 7; exportedAt: string } & Record<
  keyof typeof BACKUP_TABLES,
  Record<string, string | number | null>[]
>;

export async function exportBackup(db: SQLiteDatabase): Promise<Backup> {
  const data: Record<string, unknown[]> = {};
  for (const table of Object.keys(BACKUP_TABLES)) {
    // The light/dark and typeface choices belong to this phone, not to the data.
    const where = table === 'settings' ? " WHERE key NOT IN ('theme_mode', 'font_choice')" : '';
    data[table] = await db.getAllAsync(`SELECT * FROM ${table}${where}`);
  }
  return { app: 'finance-tracker', version: 7, exportedAt: new Date().toISOString(), ...data } as Backup;
}

export async function restoreBackup(db: SQLiteDatabase, backup: unknown) {
  const b = backup as Partial<Backup>;
  if (!b || b.app !== 'finance-tracker' || ![1, 2, 3, 4, 5, 6, 7].includes(b.version as number)) {
    throw new Error('This is not a Finance Tracker backup file.');
  }
  for (const table of Object.keys(BACKUP_TABLES) as (keyof typeof BACKUP_TABLES)[]) {
    const optional =
      (table === 'banks' && b.version === 1) ||
      (table === 'quick_expenses' && b.version! < 3) ||
      ((table === 'tags' || table === 'tx_tags') && b.version! < 4) ||
      (table === 'debt_settlements' && b.version! < 6);
    if (!Array.isArray(b[table]) && !optional) throw new Error(`Backup is missing "${table}".`);
  }

  await db.withTransactionAsync(async () => {
    for (const table of RESTORE_ORDER) {
      await db.runAsync(
        table === 'settings'
          ? "DELETE FROM settings WHERE key NOT IN ('theme_mode', 'font_choice')"
          : `DELETE FROM ${table}`,
      );
    }
    for (const table of [...RESTORE_ORDER].reverse()) {
      const cols = BACKUP_TABLES[table];
      const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
      for (const row of (b[table] ?? []) as Record<string, string | number | null>[]) {
        if (table === 'settings' && (row.key === 'theme_mode' || row.key === 'font_choice')) continue;
        await db.runAsync(sql, ...cols.map((c) => row[c] ?? COLUMN_DEFAULTS[c] ?? null));
      }
    }
    // An older backup keeps its banks in the accounts table; move them out (and seed banks if none).
    await moveLegacyAccountsToBanks(db);
    // Backups made before quick-adds existed have none; start from the defaults.
    await ensureQuickDefaults(db);
    // Older backups have withdrawals and no Credit → Debit category.
    await ensureCardCashCategory(db);
    // Older backups have no settled history; anyone already square gets theirs now.
    await settleDebts(db);
  });
}
