import type { SQLiteDatabase } from 'expo-sqlite';

import { currentCycleStart } from '@/lib/cycle';

export const DB_NAME = 'finance-tracker.db';

export const DEFAULT_CYCLE_START_DAY = 5;

/**
 * The newest schema version `migrate` brings a database to. Bump it whenever a migration is added.
 * The root layout uses it as the database provider's key, so when a new migration arrives through a live
 * code reload (which does not restart the app) the database is reopened and the upgrade actually runs.
 */
export const SCHEMA_VERSION = 5;

/** Spending categories, seeded on first launch. Only "Credit Card" counts as credit; the rest are debit. */
const DEFAULT_ACCOUNTS: { name: string; kind: 'credit' | 'debit' }[] = [
  { name: 'Credit Card', kind: 'credit' },
  { name: 'Salary', kind: 'debit' },
  { name: 'Others', kind: 'debit' },
];

/** Quick-add shortcuts a fresh install starts with. */
const DEFAULT_QUICK = ['Food', 'Fuel'];

/** Where the money moved through. Separate from the spending category. */
const DEFAULT_BANKS = ['NayaPay', 'Meezan Bank', 'Cash', 'Faysal Bank', 'SadaPay'];

/**
 * The first version stored these banks in the accounts table (as the "payment source"). They are banks,
 * not categories, so they move to the banks table (see moveLegacyAccountsToBanks).
 */
const LEGACY_ACCOUNTS = DEFAULT_BANKS;

/**
 * Moves banks that older data kept in the accounts table into the banks table, keeping every entry:
 * the entry's bank is set and its category becomes "none" (it was never categorised). Also seeds the
 * default banks when the table is empty. Safe to run repeatedly.
 */
export async function moveLegacyAccountsToBanks(db: SQLiteDatabase) {
  const count = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM banks');
  if (!count?.n) {
    for (const [i, name] of DEFAULT_BANKS.entries()) {
      await db.runAsync('INSERT INTO banks (name, sort) VALUES (?, ?)', name, i);
    }
  }

  const marks = LEGACY_ACCOUNTS.map(() => '?').join(', ');
  const legacy = await db.getAllAsync<{ id: number; name: string }>(
    `SELECT id, name FROM accounts WHERE kind = 'debit' AND name IN (${marks})`,
    ...LEGACY_ACCOUNTS,
  );
  for (const acc of legacy) {
    let bank = await db.getFirstAsync<{ id: number }>('SELECT id FROM banks WHERE name = ?', acc.name);
    if (!bank) {
      const res = await db.runAsync('INSERT INTO banks (name, sort) VALUES (?, 99)', acc.name);
      bank = { id: res.lastInsertRowId };
    }
    await db.runAsync('UPDATE transactions SET bank_id = ? WHERE account_id = ? AND bank_id IS NULL', bank.id, acc.id);
    await db.runAsync('UPDATE transactions SET account_id = NULL WHERE account_id = ?', acc.id);
    await db.runAsync('DELETE FROM accounts WHERE id = ?', acc.id);
  }

  // Only expenses have a category.
  await db.runAsync("UPDATE transactions SET account_id = NULL WHERE type != 'expense' AND account_id IS NOT NULL");
}

/**
 * Seeds the starter quick-adds (Food, Fuel) when there are none, filed under the "Others" category.
 * Used by the v5 upgrade and when an older backup (which has no quick-adds) is restored.
 */
export async function ensureQuickDefaults(db: SQLiteDatabase) {
  const count = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM quick_expenses');
  if (count?.n) return;
  const others = await db.getFirstAsync<{ id: number }>(
    "SELECT id FROM accounts WHERE name = 'Others' AND archived = 0",
  );
  for (const [i, name] of DEFAULT_QUICK.entries()) {
    await db.runAsync(
      'INSERT INTO quick_expenses (name, account_id, sort) VALUES (?, ?, ?)',
      name,
      others?.id ?? null,
      i,
    );
  }
}

export async function migrate(db: SQLiteDatabase) {
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const version = row?.user_version ?? 0;

  if (version < 1) {
    await db.withTransactionAsync(async () => {
      await db.execAsync(`
        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('credit', 'debit')),
          sort INTEGER NOT NULL DEFAULT 0,
          archived INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE cycles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          start_date TEXT NOT NULL,
          end_date TEXT,
          closed_at TEXT,
          snap_card_owed INTEGER,
          snap_owed_to_me INTEGER,
          snap_i_owe INTEGER
        );

        CREATE TABLE transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          cycle_id INTEGER NOT NULL REFERENCES cycles(id),
          type TEXT NOT NULL CHECK (type IN ('expense', 'income', 'card_payment', 'card_swipe')),
          amount INTEGER NOT NULL,
          fee INTEGER NOT NULL DEFAULT 0,
          date TEXT NOT NULL,
          account_id INTEGER REFERENCES accounts(id),
          place TEXT,
          source TEXT,
          note TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_tx_cycle ON transactions(cycle_id, date);

        CREATE TABLE people (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE
        );

        CREATE TABLE debt_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('lent', 'borrowed', 'got_back', 'paid_back')),
          amount INTEGER NOT NULL,
          date TEXT NOT NULL,
          note TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_debt_person ON debt_entries(person_id);
      `);

      await db.runAsync(
        'INSERT INTO settings (key, value) VALUES (?, ?)',
        'cycle_start_day',
        String(DEFAULT_CYCLE_START_DAY),
      );
      await db.runAsync('INSERT INTO settings (key, value) VALUES (?, ?)', 'credit_limit', '0');
      await db.runAsync('INSERT INTO settings (key, value) VALUES (?, ?)', 'card_opening_balance', '0');

      for (const [i, a] of DEFAULT_ACCOUNTS.entries()) {
        await db.runAsync('INSERT INTO accounts (name, kind, sort) VALUES (?, ?, ?)', a.name, a.kind, i);
      }

      await db.runAsync('INSERT INTO cycles (start_date) VALUES (?)', currentCycleStart(DEFAULT_CYCLE_START_DAY));

      await db.execAsync('PRAGMA user_version = 1');
    });
  }
  if (version < 2) {
    await db.withTransactionAsync(async () => {
      // Existing entries keep pointing at their old account until v3 moves the banks out.
      for (const [i, a] of DEFAULT_ACCOUNTS.entries()) {
        const exists = await db.getFirstAsync('SELECT id FROM accounts WHERE name = ? AND archived = 0', a.name);
        if (!exists) await db.runAsync('INSERT INTO accounts (name, kind, sort) VALUES (?, ?, ?)', a.name, a.kind, i);
      }
      await db.execAsync('PRAGMA user_version = 2');
    });
  }
  if (version < 3) {
    await db.withTransactionAsync(async () => {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS banks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          sort INTEGER NOT NULL DEFAULT 0,
          archived INTEGER NOT NULL DEFAULT 0
        );
      `);
      const cols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(transactions)');
      if (!cols.some((c) => c.name === 'bank_id')) {
        await db.execAsync('ALTER TABLE transactions ADD COLUMN bank_id INTEGER REFERENCES banks(id)');
      }
      await moveLegacyAccountsToBanks(db);
      await db.execAsync('PRAGMA user_version = 3');
    });
  }
  if (version < 4) {
    await db.withTransactionAsync(async () => {
      // SQLite can't edit a CHECK constraint, so rebuild the table to allow the new 'card_withdrawal' type.
      // Nothing references transactions, so this is safe; ids and every column are copied as-is.
      await db.execAsync(`
        CREATE TABLE transactions_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          cycle_id INTEGER NOT NULL REFERENCES cycles(id),
          type TEXT NOT NULL CHECK (type IN ('expense', 'income', 'card_payment', 'card_swipe', 'card_withdrawal')),
          amount INTEGER NOT NULL,
          fee INTEGER NOT NULL DEFAULT 0,
          date TEXT NOT NULL,
          account_id INTEGER REFERENCES accounts(id),
          bank_id INTEGER REFERENCES banks(id),
          place TEXT,
          source TEXT,
          note TEXT,
          created_at TEXT NOT NULL
        );
        INSERT INTO transactions_new (id, cycle_id, type, amount, fee, date, account_id, bank_id, place, source, note, created_at)
          SELECT id, cycle_id, type, amount, fee, date, account_id, bank_id, place, source, note, created_at FROM transactions;
        DROP TABLE transactions;
        ALTER TABLE transactions_new RENAME TO transactions;
        CREATE INDEX idx_tx_cycle ON transactions(cycle_id, date);
        PRAGMA user_version = 4;
      `);
    });
  }
  if (version < 5) {
    await db.withTransactionAsync(async () => {
      // A quick-add is a saved shortcut: a name (Food, Fuel, ...) plus an optional category and bank.
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS quick_expenses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          account_id INTEGER REFERENCES accounts(id),
          bank_id INTEGER REFERENCES banks(id),
          sort INTEGER NOT NULL DEFAULT 0,
          archived INTEGER NOT NULL DEFAULT 0
        );
      `);
      await ensureQuickDefaults(db);
      await db.execAsync('PRAGMA user_version = 5');
    });
  }
}
