import type { SQLiteDatabase } from 'expo-sqlite';

import { DEFAULT_CYCLE_START_DAY, ensureQuickDefaults, moveLegacyAccountsToBanks } from '@/db/schema';
import { todayISO } from '@/lib/dates';

// ---------- Types ----------

export type AccountKind = 'credit' | 'debit';
/**
 * Card entries: a payment lowers what you owe; a swipe (card -> bank) and a withdrawal (card -> cash)
 * both raise it. For swipes and withdrawals only the fee counts as spending.
 */
export type TxType = 'expense' | 'income' | 'card_payment' | 'card_swipe' | 'card_withdrawal';
export type DebtKind = 'lent' | 'borrowed' | 'got_back' | 'paid_back';

/** A spending category (Credit Card / Salary / Others / ...). */
export type Account = { id: number; name: string; kind: AccountKind; sort: number; archived: number };

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
  account_name: string | null;
  account_kind: AccountKind | null;
  bank_name: string | null;
};

export type TxInput = {
  type: TxType;
  amount: number;
  fee?: number;
  date: string;
  /** Spending category; only expenses have one. */
  account_id?: number | null;
  /** Bank the money was paid from / received in. */
  bank_id?: number | null;
  place?: string | null;
  source?: string | null;
  note?: string | null;
};

/** Spending for one category (account) in a cycle. `id` is null for entries with no category. */
export type CategoryTotal = { id: number | null; name: string; kind: AccountKind; total: number };

/** Spending paid from one bank in a cycle. */
export type BankTotal = { id: number; name: string; total: number };

export type CycleTotals = {
  /** Spending per bank (entries with a bank only). Not every expense names a bank, so this may be less than the total. */
  banks: BankTotal[];
  /** Per-category spending; always sums to `totalSpent`. Empty categories are left out. */
  breakdown: CategoryTotal[];
  debitSpent: number;
  creditSpent: number;
  totalSpent: number;
  income: number;
  cardPayments: number;
  swipeFees: number;
};

export type Person = { id: number; name: string; balance: number };
export type DebtEntry = {
  id: number;
  person_id: number;
  kind: DebtKind;
  amount: number;
  date: string;
  note: string | null;
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
  SELECT q.*, a.name AS account_name, a.kind AS account_kind, b.name AS bank_name
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

const TX_SELECT = `
  SELECT t.*, a.name AS account_name, a.kind AS account_kind, b.name AS bank_name
  FROM transactions t
  LEFT JOIN accounts a ON a.id = t.account_id
  LEFT JOIN banks b ON b.id = t.bank_id`;

export function listTransactions(db: SQLiteDatabase, cycleId: number, limit?: number) {
  return db.getAllAsync<Tx>(
    `${TX_SELECT} WHERE t.cycle_id = ? ORDER BY t.date DESC, t.id DESC ${limit ? `LIMIT ${Math.floor(limit)}` : ''}`,
    cycleId,
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
     WHERE t.cycle_id = ? AND (t.type IN ('card_payment', 'card_swipe', 'card_withdrawal') OR (t.type = 'expense' AND a.kind = 'credit'))
     ORDER BY t.date DESC, t.id DESC`,
    cycleId,
  );
}

export function getTransaction(db: SQLiteDatabase, id: number) {
  return db.getFirstAsync<Tx>(`${TX_SELECT} WHERE t.id = ?`, id);
}

const clean = (s?: string | null) => (s && s.trim() ? s.trim() : null);

export async function addTransaction(db: SQLiteDatabase, cycleId: number, tx: TxInput) {
  await db.runAsync(
    `INSERT INTO transactions (cycle_id, type, amount, fee, date, account_id, bank_id, place, source, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    cycleId,
    tx.type,
    tx.amount,
    tx.fee ?? 0,
    tx.date,
    tx.account_id ?? null,
    tx.bank_id ?? null,
    clean(tx.place),
    clean(tx.source),
    clean(tx.note),
    new Date().toISOString(),
  );
}

export async function updateTransaction(db: SQLiteDatabase, id: number, tx: TxInput) {
  await db.runAsync(
    `UPDATE transactions SET type = ?, amount = ?, fee = ?, date = ?, account_id = ?, bank_id = ?, place = ?, source = ?, note = ?
     WHERE id = ?`,
    tx.type,
    tx.amount,
    tx.fee ?? 0,
    tx.date,
    tx.account_id ?? null,
    tx.bank_id ?? null,
    clean(tx.place),
    clean(tx.source),
    clean(tx.note),
    id,
  );
}

export async function deleteTransaction(db: SQLiteDatabase, id: number) {
  await db.runAsync('DELETE FROM transactions WHERE id = ?', id);
}

/**
 * Spending rules:
 *  - expense on a credit account -> credit spent; any other expense (or no account) -> debit spent
 *  - a card swipe's fee is a cost of using the card, so it counts as credit spent
 *  - income, card payments and swipe principal are not spending
 */
export async function getCycleTotals(db: SQLiteDatabase, cycleId: number): Promise<CycleTotals> {
  const row = await db.getFirstAsync<{
    debit: number;
    credit: number;
    fees: number;
    income: number;
    payments: number;
  }>(
    `SELECT
       COALESCE(SUM(CASE WHEN t.type = 'expense' AND COALESCE(a.kind, 'debit') = 'debit' THEN t.amount END), 0) AS debit,
       COALESCE(SUM(CASE WHEN t.type = 'expense' AND a.kind = 'credit' THEN t.amount END), 0) AS credit,
       COALESCE(SUM(CASE WHEN t.type IN ('card_swipe', 'card_withdrawal') THEN t.fee END), 0) AS fees,
       COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount END), 0) AS income,
       COALESCE(SUM(CASE WHEN t.type = 'card_payment' THEN t.amount END), 0) AS payments
     FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.cycle_id = ?`,
    cycleId,
  );
  const debitSpent = row?.debit ?? 0;
  const creditSpent = (row?.credit ?? 0) + (row?.fees ?? 0);
  return {
    breakdown: await getBreakdown(db, cycleId, row?.fees ?? 0),
    banks: await getBankTotals(db, cycleId),
    debitSpent,
    creditSpent,
    totalSpent: debitSpent + creditSpent,
    income: row?.income ?? 0,
    cardPayments: row?.payments ?? 0,
    swipeFees: row?.fees ?? 0,
  };
}

/** Expenses paid from each bank, largest first. */
async function getBankTotals(db: SQLiteDatabase, cycleId: number): Promise<BankTotal[]> {
  return db.getAllAsync<BankTotal>(
    `SELECT b.id, b.name, SUM(t.amount) AS total
     FROM transactions t JOIN banks b ON b.id = t.bank_id
     WHERE t.cycle_id = ? AND t.type = 'expense'
     GROUP BY b.id HAVING total > 0 ORDER BY total DESC, b.name`,
    cycleId,
  );
}

/**
 * One row per category with spending, in the order the categories are set up.
 * Swipe fees are a cost of the card, so they are added to the credit category.
 */
async function getBreakdown(db: SQLiteDatabase, cycleId: number, swipeFees: number): Promise<CategoryTotal[]> {
  const rows = await db.getAllAsync<CategoryTotal & { archived: number }>(
    `SELECT a.id, a.name, a.kind, a.archived, COALESCE(SUM(t.amount), 0) AS total
     FROM accounts a
     LEFT JOIN transactions t ON t.account_id = a.id AND t.cycle_id = ? AND t.type = 'expense'
     GROUP BY a.id ORDER BY a.sort, a.id`,
    cycleId,
  );
  const none = await db.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
     WHERE cycle_id = ? AND type = 'expense' AND account_id IS NULL`,
    cycleId,
  );

  const list: CategoryTotal[] = rows.map(({ id, name, kind, total }) => ({ id, name, kind, total }));
  let uncategorised = none?.total ?? 0;

  if (swipeFees > 0) {
    const card = rows.find((r) => r.kind === 'credit' && !r.archived);
    if (card) list[rows.indexOf(card)].total += swipeFees;
    else uncategorised += swipeFees;
  }
  if (uncategorised > 0) list.push({ id: null, name: 'Uncategorised', kind: 'debit', total: uncategorised });

  return list.filter((c) => c.total > 0);
}

/** Spending per day (expenses + swipe fees) for the bar chart. */
export function getDailySpend(db: SQLiteDatabase, cycleId: number) {
  return db.getAllAsync<{ date: string; total: number }>(
    `SELECT date, SUM(CASE WHEN type = 'expense' THEN amount WHEN type IN ('card_swipe', 'card_withdrawal') THEN fee ELSE 0 END) AS total
     FROM transactions WHERE cycle_id = ? GROUP BY date HAVING total > 0 ORDER BY date`,
    cycleId,
  );
}

// ---------- Credit card ----------

export type CardSummary = {
  limit: number;
  owed: number;
  available: number;
  usedFraction: number;
  creditSpent: number;
  /**
   * Purchases on the card this cycle (an expense whose category is the credit card), excluding fees.
   * Entered from Home with the Credit Card category or from the Credit screen's Online button; same thing.
   */
  online: number;
  swipes: number;
  withdrawals: number;
  /** Fees on swipes and withdrawals this cycle. */
  swipeFees: number;
  payments: number;
};

/** Card owed is all-time: opening balance + card purchases + swipes + withdrawals - bill payments. */
export async function getCardSummary(db: SQLiteDatabase, cycleId: number): Promise<CardSummary> {
  const limit = await getNumberSetting(db, 'credit_limit');
  const opening = await getNumberSetting(db, 'card_opening_balance');
  const all = await db.getFirstAsync<{ purchases: number; cash: number; payments: number }>(
    `SELECT
       COALESCE(SUM(CASE WHEN t.type = 'expense' AND a.kind = 'credit' THEN t.amount END), 0) AS purchases,
       COALESCE(SUM(CASE WHEN t.type IN ('card_swipe', 'card_withdrawal') THEN t.amount END), 0) AS cash,
       COALESCE(SUM(CASE WHEN t.type = 'card_payment' THEN t.amount END), 0) AS payments
     FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id`,
  );
  const owed = opening + (all?.purchases ?? 0) + (all?.cash ?? 0) - (all?.payments ?? 0);
  const cycle = await db.getFirstAsync<{ online: number; swipes: number; withdrawals: number; payments: number }>(
    `SELECT
       COALESCE(SUM(CASE WHEN t.type = 'expense' AND a.kind = 'credit' THEN t.amount END), 0) AS online,
       COALESCE(SUM(CASE WHEN t.type = 'card_swipe' THEN t.amount END), 0) AS swipes,
       COALESCE(SUM(CASE WHEN t.type = 'card_withdrawal' THEN t.amount END), 0) AS withdrawals,
       COALESCE(SUM(CASE WHEN t.type = 'card_payment' THEN t.amount END), 0) AS payments
     FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.cycle_id = ?`,
    cycleId,
  );
  const totals = await getCycleTotals(db, cycleId);
  return {
    limit,
    owed,
    available: limit - owed,
    usedFraction: limit > 0 ? Math.min(Math.max(owed / limit, 0), 1) : 0,
    creditSpent: totals.creditSpent,
    online: cycle?.online ?? 0,
    swipes: cycle?.swipes ?? 0,
    withdrawals: cycle?.withdrawals ?? 0,
    swipeFees: totals.swipeFees,
    payments: cycle?.payments ?? 0,
  };
}

// ---------- People & debts ----------

/** lent / paid_back move the balance towards "they owe me"; borrowed / got_back move it the other way. */
const SIGNED_AMOUNT = `CASE d.kind WHEN 'lent' THEN d.amount WHEN 'paid_back' THEN d.amount ELSE -d.amount END`;

export function listPeople(db: SQLiteDatabase) {
  return db.getAllAsync<Person>(
    `SELECT p.id, p.name, COALESCE(SUM(${SIGNED_AMOUNT}), 0) AS balance
     FROM people p LEFT JOIN debt_entries d ON d.person_id = p.id
     GROUP BY p.id ORDER BY ABS(COALESCE(SUM(${SIGNED_AMOUNT}), 0)) DESC, p.name COLLATE NOCASE`,
  );
}

export async function getDebtTotals(db: SQLiteDatabase) {
  const people = await listPeople(db);
  const owedToMe = people.filter((p) => p.balance > 0).reduce((s, p) => s + p.balance, 0);
  const iOwe = people.filter((p) => p.balance < 0).reduce((s, p) => s - p.balance, 0);
  return { owedToMe, iOwe, net: owedToMe - iOwe };
}

export function getPerson(db: SQLiteDatabase, id: number) {
  return db.getFirstAsync<Person>(
    `SELECT p.id, p.name, COALESCE(SUM(${SIGNED_AMOUNT}), 0) AS balance
     FROM people p LEFT JOIN debt_entries d ON d.person_id = p.id WHERE p.id = ? GROUP BY p.id`,
    id,
  );
}

export function listDebtEntries(db: SQLiteDatabase, personId: number) {
  return db.getAllAsync<DebtEntry>(
    'SELECT id, person_id, kind, amount, date, note FROM debt_entries WHERE person_id = ? ORDER BY date DESC, id DESC',
    personId,
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
  await db.runAsync(
    'INSERT INTO debt_entries (person_id, kind, amount, date, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    personId,
    kind,
    amount,
    date,
    clean(note),
    new Date().toISOString(),
  );
}

export async function deleteDebtEntry(db: SQLiteDatabase, id: number) {
  await db.runAsync('DELETE FROM debt_entries WHERE id = ?', id);
}

export async function deletePerson(db: SQLiteDatabase, id: number) {
  await db.runAsync('DELETE FROM people WHERE id = ?', id);
}

// ---------- Backup / restore ----------

/** Column whitelists keep restore safe even if a backup file was hand-edited. */
const BACKUP_TABLES = {
  settings: ['key', 'value'],
  accounts: ['id', 'name', 'kind', 'sort', 'archived'],
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
    'account_id',
    'bank_id',
    'place',
    'source',
    'note',
    'created_at',
  ],
  people: ['id', 'name'],
  debt_entries: ['id', 'person_id', 'kind', 'amount', 'date', 'note', 'created_at'],
} as const;

/** Delete children before parents, insert parents before children. */
const RESTORE_ORDER = [
  'debt_entries',
  'transactions',
  'quick_expenses',
  'people',
  'cycles',
  'accounts',
  'banks',
  'settings',
] as const;

/** Version 2 added banks, version 3 quick-adds. Older backups still restore. */
export type Backup = { app: 'finance-tracker'; version: 1 | 2 | 3; exportedAt: string } & Record<
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
  return { app: 'finance-tracker', version: 3, exportedAt: new Date().toISOString(), ...data } as Backup;
}

export async function restoreBackup(db: SQLiteDatabase, backup: unknown) {
  const b = backup as Partial<Backup>;
  if (!b || b.app !== 'finance-tracker' || (b.version !== 1 && b.version !== 2 && b.version !== 3)) {
    throw new Error('This is not a Finance Tracker backup file.');
  }
  for (const table of Object.keys(BACKUP_TABLES) as (keyof typeof BACKUP_TABLES)[]) {
    const optional = (table === 'banks' && b.version === 1) || (table === 'quick_expenses' && b.version! < 3);
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
        await db.runAsync(sql, ...cols.map((c) => row[c] ?? null));
      }
    }
    // An older backup keeps its banks in the accounts table; move them out (and seed banks if none).
    await moveLegacyAccountsToBanks(db);
    // Backups made before quick-adds existed have none; start from the defaults.
    await ensureQuickDefaults(db);
  });
}
