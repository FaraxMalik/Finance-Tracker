import type { SQLiteDatabase } from 'expo-sqlite';

import { settleDebts } from '@/db/settle';
import { currentCycleStart } from '@/lib/cycle';

export const DB_NAME = 'finance-tracker.db';

export const DEFAULT_CYCLE_START_DAY = 5;

/**
 * The newest schema version `migrate` brings a database to. Bump it whenever a migration is added.
 * The root layout uses it as the database provider's key, so when a new migration arrives through a live
 * code reload (which does not restart the app) the database is reopened and the upgrade actually runs.
 */
export const SCHEMA_VERSION = 10;

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

/** The category for spending money moved off the card into a bank (see ensureCardCashCategory). */
export const CARD_CASH_CATEGORY = 'Credit → Debit';

/**
 * Brings card entries to the current model, safe to run repeatedly (the v8 upgrade and every restore use it):
 *  - "Withdrawal" and "Swipe" are one thing now, Credit → Debit, stored as `card_swipe`.
 *  - There is a Credit → Debit category for spending that money: credit spending that does not add to what the
 *    card owes again (the move itself already did). It is created once; a removed one is not brought back.
 */
export async function ensureCardCashCategory(db: SQLiteDatabase) {
  await db.runAsync("UPDATE transactions SET type = 'card_swipe' WHERE type = 'card_withdrawal'");
  const existing = await db.getFirstAsync('SELECT id FROM accounts WHERE card_cash = 1');
  if (existing) return;
  const row = await db.getFirstAsync<{ next: number }>('SELECT COALESCE(MAX(sort), -1) + 1 AS next FROM accounts');
  await db.runAsync(
    "INSERT INTO accounts (name, kind, sort, card_cash) VALUES (?, 'credit', ?, 1)",
    CARD_CASH_CATEGORY,
    row?.next ?? 0,
  );
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
  if (version < 6) {
    await db.withTransactionAsync(async () => {
      // A friend's share of an expense you paid is an "I lent" entry linked to that expense.
      const cols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(debt_entries)');
      if (!cols.some((c) => c.name === 'tx_id')) {
        await db.execAsync(
          'ALTER TABLE debt_entries ADD COLUMN tx_id INTEGER REFERENCES transactions(id) ON DELETE CASCADE',
        );
      }
      await db.execAsync('CREATE INDEX IF NOT EXISTS idx_debt_tx ON debt_entries(tx_id); PRAGMA user_version = 6;');
    });
  }
  if (version < 7) {
    await db.withTransactionAsync(async () => {
      // Tags: your own labels (Trip, Office, ...) on any entries, to total them up separately.
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE COLLATE NOCASE,
          sort INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS tx_tags (
          tx_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
          tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
          PRIMARY KEY (tx_id, tag_id)
        );
        CREATE INDEX IF NOT EXISTS idx_txtag_tag ON tx_tags(tag_id);
        PRAGMA user_version = 7;
      `);
    });
  }
  if (version < 8) {
    await db.withTransactionAsync(async () => {
      // A card purchase is made at a shop's machine ('pos') or online (NULL, which every older purchase was).
      const txCols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(transactions)');
      if (!txCols.some((c) => c.name === 'channel')) {
        await db.execAsync('ALTER TABLE transactions ADD COLUMN channel TEXT');
      }
      // Marks the Credit → Debit category: credit spending that the card already owes for.
      const accCols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(accounts)');
      if (!accCols.some((c) => c.name === 'card_cash')) {
        await db.execAsync('ALTER TABLE accounts ADD COLUMN card_cash INTEGER NOT NULL DEFAULT 0');
      }
      await ensureCardCashCategory(db);
      await db.execAsync('PRAGMA user_version = 8');
    });
  }
  if (version < 9) {
    await db.withTransactionAsync(async () => {
      // Once everything with a person adds up to zero, those entries become their settled history.
      // (`side` belongs to the very next migration, but a fresh install runs both in one go, so it is included
      // here too; `settleDebts` always needs it. An existing v9 phone gets it from the version-10 block below.)
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS debt_settlements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
          side TEXT NOT NULL DEFAULT 'they',
          settled_on TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_settle_person ON debt_settlements(person_id);
      `);
      const cols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(debt_entries)');
      if (!cols.some((c) => c.name === 'settlement_id')) {
        await db.execAsync(
          'ALTER TABLE debt_entries ADD COLUMN settlement_id INTEGER REFERENCES debt_settlements(id) ON DELETE SET NULL',
        );
      }
      // People who are already square get their history filed as settled now.
      await settleDebts(db);
      await db.execAsync('PRAGMA user_version = 9');
    });
  }
  if (version < 10) {
    await db.withTransactionAsync(async () => {
      // What they owe you and what you owe them settle separately now (lending for one thing and borrowing for
      // another are different arrangements), so a settled stretch belongs to one side.
      const cols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(debt_settlements)');
      if (!cols.some((c) => c.name === 'side')) {
        await db.execAsync("ALTER TABLE debt_settlements ADD COLUMN side TEXT NOT NULL DEFAULT 'they'");
      }
      // Rebuilds every settlement from the entries under the new per-side rule.
      await settleDebts(db);
      await db.execAsync('PRAGMA user_version = 10');
    });
  }
}
