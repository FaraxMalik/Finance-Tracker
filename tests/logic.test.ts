/// <reference types="node" />
/**
 * Logic tests: the database schema/migrations, money rules, cycle maths, backups and the All-entries filters.
 *
 * They run the app's real query code against Node's built-in SQLite (`node:sqlite`, Node >= 22.13) through a tiny
 * adapter that mimics the parts of the expo-sqlite API the app uses, so no phone or emulator is needed.
 *
 *   npm test
 */
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';

import * as q from '@/db/queries';
import { migrate, SCHEMA_VERSION } from '@/db/schema';
import {
  activeFilterCount,
  applyFilters,
  groupByDate,
  myShare,
  NONE,
  NO_FILTERS,
  summarize,
  summarizeDebts,
  type Filters,
} from '@/lib/ledger';
import { currentCycleStart, nextBoundary, nominalEnd, cycleProgress } from '@/lib/cycle';
import { toPaisa, formatPKR, percentShares } from '@/lib/money';
import { splitExpense } from '@/lib/split';
import { addDays } from '@/lib/dates';

// Minimal expo-sqlite look-alike over node:sqlite
function makeDb(): any {
  const raw = new DatabaseSync(':memory:');
  const norm = (a: any[]) => (a.length === 1 && Array.isArray(a[0]) ? a[0] : a);
  return {
    async execAsync(sql: string) {
      raw.exec(sql);
    },
    async runAsync(sql: string, ...a: any[]) {
      const r = raw.prepare(sql).run(...norm(a));
      return { lastInsertRowId: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    async getAllAsync(sql: string, ...a: any[]) {
      return raw.prepare(sql).all(...norm(a));
    },
    async getFirstAsync(sql: string, ...a: any[]) {
      return raw.prepare(sql).get(...norm(a)) ?? null;
    },
    async withTransactionAsync(fn: () => Promise<void>) {
      raw.exec('BEGIN');
      try {
        await fn();
        raw.exec('COMMIT');
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

const R = (n: number) => n * 100;
let passed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    passed++;
    console.log('ok  ', name);
  } catch (e) {
    console.log('FAIL', name, '\n', e);
    process.exitCode = 1;
  }
};

(async () => {
  await test('cycle boundaries (5th)', () => {
    assert.equal(currentCycleStart(5, '2026-09-20'), '2026-09-05');
    assert.equal(currentCycleStart(5, '2026-09-05'), '2026-09-05');
    assert.equal(currentCycleStart(5, '2026-09-04'), '2026-08-05');
    assert.equal(currentCycleStart(5, '2026-01-02'), '2025-12-05');
    assert.equal(nextBoundary('2026-09-05', 5), '2026-10-05');
    assert.equal(nextBoundary('2026-09-02', 5), '2026-09-05');
    assert.equal(nominalEnd('2026-12-05', 5), '2027-01-04');
    const p = cycleProgress('2026-09-05', 5, '2026-09-20');
    assert.deepEqual([p.totalDays, p.dayNumber, p.daysLeft, p.overdue], [30, 16, 14, false]);
    assert.equal(cycleProgress('2026-09-05', 5, '2026-10-06').overdue, true);
  });

  await test('money parsing/format', () => {
    assert.equal(toPaisa('1,250.50'), 125050);
    assert.equal(toPaisa('abc'), 0);
    assert.equal(formatPKR(-150000), '-Rs 1,500');
  });

  const db = makeDb();
  await migrate(db);
  const cycle = (await q.getActiveCycle(db))!;
  const accts = await q.listAccounts(db);
  const byName = Object.fromEntries(accts.map((a) => [a.name, a.id]));

  const bk = Object.fromEntries((await q.listBanks(db)).map((b) => [b.name, b.id]));

  await test('seeded banks are separate from categories', async () => {
    assert.deepEqual(
      (await q.listBanks(db)).map((b) => b.name),
      ['NayaPay', 'Meezan Bank', 'Cash', 'Faysal Bank', 'SadaPay'],
    );
  });

  await test('seeded accounts', () => {
    assert.deepEqual(
      accts.map((a) => [a.name, a.kind, a.card_cash]),
      [
        ['Credit Card', 'credit', 0],
        ['Salary', 'debit', 0],
        ['Others', 'debit', 0],
        ['Credit → Debit', 'credit', 1],
      ],
    );
  });

  await q.setSetting(db, 'credit_limit', String(R(100000)));
  await q.setSetting(db, 'card_opening_balance', String(R(5000)));

  const add = (t: any) => q.addTransaction(db, cycle.id, { date: '2026-09-10', ...t });
  await add({ type: 'income', amount: R(80000), source: 'Salary', account_id: byName['Salary'] });
  await add({ type: 'income', amount: R(10000), source: 'Project' });
  await add({ type: 'expense', amount: R(2000), account_id: byName['Others'], bank_id: bk['Cash'], place: 'Grocery' }); // debit
  await add({ type: 'expense', amount: R(500), account_id: byName['Others'], bank_id: bk['NayaPay'] }); // debit
  await add({ type: 'expense', amount: R(300) }); // no account -> debit
  await add({ type: 'expense', amount: R(4000), account_id: byName['Credit Card'], place: 'Shoes' }); // online purchase
  await add({ type: 'expense', amount: R(1500), account_id: byName['Credit Card'], channel: 'pos', place: 'Dinner' }); // POS purchase
  await add({ type: 'card_swipe', amount: R(20000) }); // Credit → Debit: owed +20000, not spending
  await add({ type: 'expense', amount: R(7000), account_id: byName['Credit → Debit'], bank_id: bk['Meezan Bank'] }); // spending that money
  await add({ type: 'card_payment', amount: R(10000) }); // owed -10000

  await test('cycle totals: debit / credit / income; Credit → Debit moves & payments not spending', async () => {
    const t = await q.getCycleTotals(db, cycle.id);
    assert.equal(t.debitSpent, R(2800));
    assert.equal(t.creditSpent, R(4000) + R(1500) + R(7000), 'card purchases + Credit → Debit spending');
    assert.equal(t.totalSpent, R(2800) + R(12500));
    assert.equal(t.income, R(90000), 'money moved off the card is not income');
    assert.equal(t.creditToDebit, R(20000), 'but Home can show it beside income');
    assert.equal(t.cardPayments, R(10000));
  });

  await test('category breakdown: individual totals, sums to total', async () => {
    const t = await q.getCycleTotals(db, cycle.id);
    const by = Object.fromEntries(t.breakdown.map((c) => [c.name, c.total]));
    assert.deepEqual(by, {
      'Credit Card': R(4000) + R(1500), // online + POS
      Others: R(2000) + R(500), // two categorised expenses
      'Credit → Debit': R(7000),
      Uncategorised: R(300), // the expense with no category
    });
    assert.ok(!('Salary' in by), 'categories with no spending are left out');
    assert.equal(
      t.breakdown.reduce((s, c) => s + c.total, 0),
      t.totalSpent,
    );
  });

  await test('bank totals: expenses per bank, largest first, no bank = not listed', async () => {
    const t = await q.getCycleTotals(db, cycle.id);
    assert.deepEqual(
      t.banks.map((b) => [b.name, b.total]),
      [
        ['Meezan Bank', R(7000)],
        ['Cash', R(2000)],
        ['NayaPay', R(500)],
      ],
    );
  });

  await test('card owed = opening + POS + online + Credit → Debit - payments; spending that money is not owed twice', async () => {
    const c = await q.getCardSummary(db, cycle.id);
    assert.equal(c.owed, R(5000 + 4000 + 1500 + 20000 - 10000));
    assert.equal(c.available, R(100000 - 20500));
    assert.ok(Math.abs(c.usedFraction - 0.205) < 1e-9);
    assert.equal(c.pos, R(1500));
    assert.equal(c.online, R(4000), 'the credit-card expense entered like any other expense is the Online total');
    assert.equal(c.creditToDebit, R(20000));
    assert.equal(c.creditToDebitSpent, R(7000));
    assert.equal(c.payments, R(10000));
  });

  await test('daily spend groups expenses only', async () => {
    const d = await q.getDailySpend(db, cycle.id);
    assert.deepEqual(
      d.map((x) => ({ ...x })),
      [{ date: '2026-09-10', total: R(2800 + 5500 + 7000) }],
    );
  });

  await test('card activity list: card purchases (wherever entered), Credit → Debit and payments only', async () => {
    const list = await q.listCardTransactions(db, cycle.id);
    assert.deepEqual(list.map((t) => [t.type, t.place, t.channel]).sort(), [
      ['card_payment', null, null],
      ['card_swipe', null, null],
      ['expense', 'Dinner', 'pos'],
      ['expense', 'Shoes', null],
    ]);
    // Debit spending and spending of Credit → Debit money must NOT appear on the Credit screen.
    assert.ok(!list.some((t) => t.account_name === 'Others' || t.account_name === 'Credit → Debit'));
  });

  await test('Home recent entries leave out Credit → Debit moves', async () => {
    const recent = await q.listRecentTransactions(db, cycle.id, 50);
    assert.equal(recent.length, 9);
    assert.ok(!recent.some((t) => t.type === 'card_swipe'));
    assert.equal((await q.listRecentTransactions(db, cycle.id, 3)).length, 3);
  });

  await test('debts: balances and totals', async () => {
    const ali = await q.findOrCreatePerson(db, 'Ali');
    const same = await q.findOrCreatePerson(db, ' ali ');
    assert.equal(ali, same, 'names are matched case-insensitively');
    const sara = await q.findOrCreatePerson(db, 'Sara');
    await q.addDebtEntry(db, ali, 'lent', R(5000), '2026-09-10');
    await q.addDebtEntry(db, ali, 'got_back', R(1000), '2026-09-12'); // Ali owes 4000
    await q.addDebtEntry(db, sara, 'borrowed', R(3000), '2026-09-11');
    await q.addDebtEntry(db, sara, 'paid_back', R(500), '2026-09-13'); // I owe Sara 2500
    const people = await q.listPeople(db);
    assert.deepEqual(
      people.map((p) => [p.name, p.balance]),
      [
        ['Ali', R(4000)],
        ['Sara', -R(2500)],
      ],
    );
    const tot = await q.getDebtTotals(db);
    assert.deepEqual({ ...tot }, { owedToMe: R(4000), iOwe: R(2500), net: R(1500) });
  });

  await test('start new cycle: closes, snapshots, resets totals, keeps balances', async () => {
    await q.startNewCycle(db);
    const closed = await q.listClosedCycles(db);
    assert.equal(closed.length, 1);
    assert.equal(closed[0].totalSpent, R(15300));
    assert.equal(closed[0].snap_card_owed, R(20500));
    assert.equal(closed[0].snap_owed_to_me, R(4000));
    assert.equal(closed[0].snap_i_owe, R(2500));
    const fresh = (await q.getActiveCycle(db))!;
    assert.notEqual(fresh.id, cycle.id);
    const t = await q.getCycleTotals(db, fresh.id);
    assert.equal(t.totalSpent, 0);
    assert.equal(t.income, 0);
    const c = await q.getCardSummary(db, fresh.id);
    assert.equal(c.owed, R(20500), 'card debt carries over');
    assert.equal((await q.getDebtTotals(db)).owedToMe, R(4000), 'debts carry over');
    // old cycle report is unchanged
    assert.equal((await q.listTransactions(db, cycle.id)).length, 10);
  });

  await test('backup -> wipe -> restore round trip', async () => {
    const backup = JSON.parse(JSON.stringify(await q.exportBackup(db)));
    const db2 = makeDb();
    await migrate(db2);
    await q.restoreBackup(db2, backup);
    const a = (await q.getActiveCycle(db))!,
      b = (await q.getActiveCycle(db2))!;
    assert.equal(a.id, b.id);
    assert.deepEqual(
      (await q.listPeople(db2)).map((x) => ({ ...x })),
      (await q.listPeople(db)).map((x) => ({ ...x })),
    );
    const old = (await q.listClosedCycles(db2))[0];
    assert.equal(old.totalSpent, R(15300));
    assert.equal((await q.getCardSummary(db2, b.id)).owed, R(20500));
    await assert.rejects(() => q.restoreBackup(db2, { app: 'other' }), /not a Finance Tracker backup/);
  });

  await test('restore rejects hostile column names (whitelist)', async () => {
    const backup: any = JSON.parse(JSON.stringify(await q.exportBackup(db)));
    backup.people = [{ id: 99, name: 'x', 'name) VALUES (1); DROP TABLE settings; --': 1 }];
    backup.debt_entries = [];
    const db3 = makeDb();
    await migrate(db3);
    await q.restoreBackup(db3, backup);
    assert.equal((await q.listPeople(db3)).length, 1);
    assert.ok((await q.getSetting(db3, 'credit_limit')) !== undefined);
  });

  await test('failed restore rolls back and leaves existing data intact', async () => {
    const backup: any = JSON.parse(JSON.stringify(await q.exportBackup(db)));
    backup.transactions[0].cycle_id = 9999; // dangling reference
    const before = (await q.listPeople(db)).length;
    await assert.rejects(() => q.restoreBackup(db, backup));
    assert.equal((await q.listPeople(db)).length, before);
    assert.equal((await q.listClosedCycles(db)).length, 1);
  });

  const legacyPhone = async (version: number) => {
    // A phone that ran an earlier release: the banks live in the accounts table, entries point at them.
    const old = makeDb();
    await migrate(old);
    // An old phone predates quick-adds, so drop that table too (it points at the accounts we are about to remove).
    await old.execAsync(
      'DROP TABLE quick_expenses; DELETE FROM transactions; DELETE FROM banks; DELETE FROM accounts;',
    );
    await old.execAsync(`PRAGMA user_version = ${version};`);
    await old.execAsync('DROP TABLE banks; ALTER TABLE transactions DROP COLUMN bank_id;');
    await old.runAsync("INSERT INTO accounts (name, kind, sort) VALUES ('Credit Card', 'credit', 0)");
    for (const [i, n] of ['NayaPay', 'Meezan Bank', 'Cash', 'Faysal Bank', 'SadaPay'].entries())
      await old.runAsync(
        'INSERT INTO accounts (name, kind, sort, archived) VALUES (?, ?, ?, ?)',
        n,
        'debit',
        i + 1,
        version >= 2 ? 1 : 0,
      );
    if (version >= 2) {
      await old.runAsync("INSERT INTO accounts (name, kind, sort) VALUES ('Salary', 'debit', 1)");
      await old.runAsync("INSERT INTO accounts (name, kind, sort) VALUES ('Others', 'debit', 2)");
    }
    const c = (await q.getActiveCycle(old))!;
    const id = async (n: string) =>
      ((await old.getFirstAsync('SELECT id FROM accounts WHERE name = ?', n)) as any).id as number;
    const ins = (type: string, amount: number, acct: number | null) =>
      old.runAsync(
        "INSERT INTO transactions (cycle_id, type, amount, fee, date, account_id, created_at) VALUES (?, ?, ?, 0, '2026-09-10', ?, 'x')",
        c.id,
        type,
        R(amount),
        acct,
      );
    await ins('expense', 750, await id('Cash'));
    await ins('expense', 300, await id('Credit Card'));
    await ins('card_payment', 1000, await id('Meezan Bank'));
    return { old, c };
  };

  for (const version of [1, 2]) {
    await test(`upgrade from v${version}: banks move out of categories, nothing is lost, idempotent`, async () => {
      const { old, c } = await legacyPhone(version);
      const before = await q.getCycleTotals(old, c.id).catch(() => null); // schema is mid-upgrade; only used to prove it runs after
      void before;
      await migrate(old);
      await migrate(old); // a second run must change nothing

      assert.deepEqual(
        (await q.listBanks(old)).map((b) => b.name),
        ['NayaPay', 'Meezan Bank', 'Cash', 'Faysal Bank', 'SadaPay'],
      );
      assert.deepEqual((await q.listAccounts(old, true)).map((a) => a.name).sort(), [
        'Credit Card',
        'Credit → Debit',
        'Others',
        'Salary',
      ]);

      const t = await q.getCycleTotals(old, c.id);
      assert.equal(t.totalSpent, R(750) + R(300), 'totals unchanged by the move');
      const txs = await q.listTransactions(old, c.id);
      const cash = txs.find((x) => x.amount === R(750))!;
      assert.equal(cash.bank_name, 'Cash', 'the old "Cash" account is now the entry\'s bank');
      assert.equal(cash.account_name, null, 'and its category is unknown, not guessed');
      const bill = txs.find((x) => x.type === 'card_payment')!;
      assert.equal(bill.bank_name, 'Meezan Bank');
      assert.equal(bill.account_id, null);
      assert.equal(txs.find((x) => x.amount === R(300))!.account_name, 'Credit Card', 'credit card stays a category');
      assert.deepEqual(
        t.banks.map((b) => [b.name, b.total]),
        [['Cash', R(750)]],
      );
    });
  }

  await test('restoring an old (v1) backup moves its banks out of categories too', async () => {
    const { old, c } = await legacyPhone(1);
    await migrate(old);
    const v2 = JSON.parse(JSON.stringify(await q.exportBackup(old)));
    assert.equal(v2.version, 7);
    assert.ok(Array.isArray(v2.banks));

    // Build a genuine v1 file: legacy accounts, entries pointing at them, no banks table, no bank_id.
    const v1: any = JSON.parse(JSON.stringify(v2));
    delete v1.banks;
    delete v1.quick_expenses; // a real v1 file predates both banks and quick-adds
    v1.version = 1;
    v1.accounts = [
      { id: 1, name: 'Credit Card', kind: 'credit', sort: 0, archived: 0 },
      { id: 2, name: 'Cash', kind: 'debit', sort: 1, archived: 0 },
    ];
    v1.transactions = [
      {
        id: 1,
        cycle_id: c.id,
        type: 'expense',
        amount: R(750),
        fee: 0,
        date: '2026-09-10',
        account_id: 2,
        place: null,
        source: null,
        note: null,
        created_at: 'x',
      },
      {
        id: 2,
        cycle_id: c.id,
        type: 'expense',
        amount: R(300),
        fee: 0,
        date: '2026-09-10',
        account_id: 1,
        place: null,
        source: null,
        note: null,
        created_at: 'x',
      },
    ];
    const fresh = makeDb();
    await migrate(fresh);
    await q.restoreBackup(fresh, v1);
    const active = (await q.getActiveCycle(fresh))!;
    const t = await q.getCycleTotals(fresh, active.id);
    assert.equal(t.totalSpent, R(1050));
    assert.deepEqual(
      t.banks.map((b) => [b.name, b.total]),
      [['Cash', R(750)]],
    );
    assert.ok((await q.listBanks(fresh)).length >= 5, 'default banks are back');
    assert.ok(!(await q.listAccounts(fresh, true)).some((a) => a.name === 'Cash'), 'Cash is no longer a category');
  });

  /** A phone on v7: withdrawals and swipes with fees, no POS column, no Credit → Debit category. */
  const v7Phone = async () => {
    const d = makeDb();
    await migrate(d);
    await d.execAsync(`
      DELETE FROM accounts WHERE card_cash = 1;
      ALTER TABLE accounts DROP COLUMN card_cash;
      ALTER TABLE transactions DROP COLUMN channel;
      PRAGMA user_version = 7;
    `);
    const c = (await q.getActiveCycle(d))!;
    await q.setSetting(d, 'card_opening_balance', String(R(1000)));
    const card = ((await d.getFirstAsync("SELECT id FROM accounts WHERE name = 'Credit Card'")) as any).id;
    const ins = (type: string, amount: number, fee: number, account: number | null = null) =>
      d.runAsync(
        "INSERT INTO transactions (cycle_id, type, amount, fee, date, account_id, created_at) VALUES (?, ?, ?, ?, '2026-09-10', ?, 'x')",
        c.id,
        type,
        R(amount),
        R(fee),
        account,
      );
    await ins('card_withdrawal', 5000, 150);
    await ins('card_swipe', 2000, 60);
    await ins('expense', 1000, 0, card);
    await ins('card_payment', 3000, 0);
    return { d, c };
  };

  await test('v7 -> v8: withdrawals become Credit → Debit, old fees stop counting, the category is added once', async () => {
    const { d, c } = await v7Phone();
    await migrate(d);
    await migrate(d);
    assert.equal(((await d.getFirstAsync('PRAGMA user_version')) as any).user_version, SCHEMA_VERSION);
    assert.equal(
      ((await d.getFirstAsync("SELECT COUNT(*) AS n FROM transactions WHERE type = 'card_withdrawal'")) as any).n,
      0,
    );
    assert.deepEqual(
      (await q.listAccounts(d)).filter((a) => a.card_cash).map((a) => [a.name, a.kind]),
      [['Credit → Debit', 'credit']],
    );

    const card = await q.getCardSummary(d, c.id);
    assert.equal(card.owed, R(1000 + 5000 + 2000 + 1000 - 3000), 'what the card owes is unchanged');
    assert.equal(card.creditToDebit, R(7000));
    assert.equal(card.online, R(1000), 'older card purchases are online');
    assert.equal(card.pos, 0);

    const t = await q.getCycleTotals(d, c.id);
    assert.equal(t.totalSpent, R(1000), 'fees no longer count as spending');
    assert.deepEqual(
      (await q.getDailySpend(d, c.id)).map((x) => ({ ...x })),
      [{ date: '2026-09-10', total: R(1000) }],
    );
  });

  await test('a removed Credit → Debit category is not brought back', async () => {
    const d = makeDb();
    await migrate(d);
    const cc = (await q.listAccounts(d)).find((a) => a.card_cash)!;
    await q.archiveAccount(d, cc.id);
    await d.execAsync('PRAGMA user_version = 7');
    await migrate(d);
    assert.equal(((await d.getFirstAsync('SELECT COUNT(*) AS n FROM accounts WHERE card_cash = 1')) as any).n, 1);
    assert.ok(!(await q.listAccounts(d)).some((a) => a.card_cash));
  });

  await test('restoring a v4 backup (withdrawals, no POS, no Credit → Debit) brings it to the new model', async () => {
    const { d, c } = await v7Phone();
    await migrate(d);
    const v4: any = JSON.parse(JSON.stringify(await q.exportBackup(d)));
    v4.version = 4;
    v4.accounts = v4.accounts.filter((a: any) => !a.card_cash).map(({ card_cash, ...a }: any) => a);
    v4.transactions = v4.transactions.map(({ channel, ...t }: any, i: number) =>
      i === 0 ? { ...t, type: 'card_withdrawal' } : t,
    );
    assert.equal(v4.transactions[0].amount, R(5000));

    const d2 = makeDb();
    await migrate(d2);
    await q.restoreBackup(d2, v4);
    assert.deepEqual(
      (await q.listAccounts(d2)).map((a) => [a.name, a.card_cash]),
      [
        ['Credit Card', 0],
        ['Salary', 0],
        ['Others', 0],
        ['Credit → Debit', 1],
      ],
    );
    const card = await q.getCardSummary(d2, c.id);
    assert.equal(card.creditToDebit, R(7000));
    assert.equal(card.owed, R(6000));
  });

  await test('a POS purchase entered on Home: owed, POS total, card list; editing can switch it to online', async () => {
    const d = makeDb();
    await migrate(d);
    const c = (await q.getActiveCycle(d))!;
    const card = (await q.listAccounts(d)).find((a) => a.name === 'Credit Card')!;
    const id = await q.addTransaction(d, c.id, {
      type: 'expense',
      amount: R(2500),
      account_id: card.id,
      channel: 'pos',
      date: '2026-09-10',
    });
    let s = await q.getCardSummary(d, c.id);
    assert.deepEqual([s.owed, s.pos, s.online], [R(2500), R(2500), 0]);
    assert.equal((await q.getTransaction(d, id))!.channel, 'pos');
    await q.updateTransaction(d, id, { type: 'expense', amount: R(2500), account_id: card.id, date: '2026-09-10' });
    s = await q.getCardSummary(d, c.id);
    assert.deepEqual([s.owed, s.pos, s.online], [R(2500), 0, R(2500)]);
  });

  await test('v3 -> v4 rebuild keeps every row and id, allows withdrawals, restores the index', async () => {
    const d = makeDb();
    await migrate(d);
    // Put it back into the v3 shape: old CHECK (no withdrawal type), then add rows.
    await d.execAsync(`
      DROP TABLE transactions;
      CREATE TABLE transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cycle_id INTEGER NOT NULL REFERENCES cycles(id),
        type TEXT NOT NULL CHECK (type IN ('expense', 'income', 'card_payment', 'card_swipe')),
        amount INTEGER NOT NULL, fee INTEGER NOT NULL DEFAULT 0, date TEXT NOT NULL,
        account_id INTEGER REFERENCES accounts(id), place TEXT, source TEXT, note TEXT, created_at TEXT NOT NULL,
        bank_id INTEGER REFERENCES banks(id)
      );
      PRAGMA user_version = 3;
    `);
    const c = (await q.getActiveCycle(d))!;
    const bank = (await q.listBanks(d))[1];
    await d.runAsync(
      "INSERT INTO transactions (id, cycle_id, type, amount, fee, date, account_id, bank_id, place, source, note, created_at) VALUES (7, ?, 'expense', ?, 0, '2026-09-10', 1, ?, 'Shoes', NULL, 'n', 't1')",
      c.id,
      R(120),
      bank.id,
    );
    await d.runAsync(
      "INSERT INTO transactions (id, cycle_id, type, amount, fee, date, created_at) VALUES (9, ?, 'card_swipe', ?, ?, '2026-09-11', 't2')",
      c.id,
      R(400),
      R(12),
    );
    await assert.rejects(
      () =>
        d.runAsync(
          "INSERT INTO transactions (cycle_id, type, amount, date, created_at) VALUES (?, 'card_withdrawal', 1, '2026-09-11', 'x')",
          c.id,
        ),
      /CHECK/,
    );

    await migrate(d);
    await migrate(d);
    const rows = (await q.listTransactions(d, c.id)).map((x) => ({
      id: x.id,
      type: x.type,
      amount: x.amount,
      fee: x.fee,
      bank: x.bank_name,
      place: x.place,
      note: x.note,
    }));
    assert.deepEqual(
      rows.sort((a, b) => a.id - b.id),
      [
        { id: 7, type: 'expense', amount: R(120), fee: 0, bank: bank.name, place: 'Shoes', note: 'n' },
        { id: 9, type: 'card_swipe', amount: R(400), fee: R(12), bank: null, place: null, note: null },
      ],
    );
    await d.runAsync(
      "INSERT INTO transactions (cycle_id, type, amount, date, created_at) VALUES (?, 'card_withdrawal', 1, '2026-09-12', 'x')",
      c.id,
    );
    assert.equal((await q.listTransactions(d, c.id)).length, 3);
    assert.ok(await d.getFirstAsync("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_tx_cycle'"));
    assert.equal(
      ((await d.getFirstAsync('PRAGMA user_version')) as any).user_version,
      SCHEMA_VERSION,
      'and continues on to the latest version',
    );
  });

  await test('quick-adds: Food and Fuel are there from the start, filed under Others', async () => {
    const d = makeDb();
    await migrate(d);
    const list = await q.listQuick(d);
    assert.deepEqual(
      list.map((x) => [x.name, x.account_name, x.bank_name]),
      [
        ['Food', 'Others', null],
        ['Fuel', 'Others', null],
      ],
    );
  });

  await test('quick-adds: add, edit, remove; saving one is a normal expense with its name and category', async () => {
    const d = makeDb();
    await migrate(d);
    const c = (await q.getActiveCycle(d))!;
    const banks = await q.listBanks(d);
    const cash = banks.find((b) => b.name === 'Cash')!;
    const salary = (await q.listAccounts(d)).find((a) => a.name === 'Salary')!;

    await q.addQuick(d, 'Chai', salary.id, cash.id);
    let list = await q.listQuick(d);
    assert.deepEqual(
      list.map((x) => x.name),
      ['Food', 'Fuel', 'Chai'],
      'new ones go to the end',
    );
    const chai = list[2];
    await q.updateQuick(d, chai.id, 'Tea', salary.id, null);
    assert.equal((await q.getQuick(d, chai.id))!.name, 'Tea');
    assert.equal((await q.getQuick(d, chai.id))!.bank_id, null);

    // "Just choose it, type the amount": this is what the quick screen writes.
    const food = list[0];
    await q.addTransaction(d, c.id, {
      type: 'expense',
      amount: R(250),
      date: '2026-09-22',
      account_id: food.account_id,
      bank_id: food.bank_id,
      place: food.name,
    });
    const tx = (await q.listTransactions(d, c.id))[0];
    assert.equal(tx.place, 'Food');
    assert.equal(tx.account_name, 'Others');
    assert.equal(tx.date, '2026-09-22');
    const t = await q.getCycleTotals(d, c.id);
    assert.equal(t.totalSpent, R(250));
    assert.deepEqual(
      t.breakdown.map((x) => [x.name, x.total]),
      [['Others', R(250)]],
    );

    await q.archiveQuick(d, chai.id);
    list = await q.listQuick(d);
    assert.deepEqual(
      list.map((x) => x.name),
      ['Food', 'Fuel'],
    );
    assert.equal((await q.listTransactions(d, c.id)).length, 1, 'existing entries are untouched');
  });

  await test('upgrade v4 -> v5 adds the quick-adds once and keeps everything else', async () => {
    const d = makeDb();
    await migrate(d);
    const c = (await q.getActiveCycle(d))!;
    await q.addTransaction(d, c.id, { type: 'expense', amount: R(90), date: '2026-09-10', place: 'Old entry' });
    await d.execAsync('DROP TABLE quick_expenses; PRAGMA user_version = 4;');
    await migrate(d);
    await migrate(d);
    assert.deepEqual(
      (await q.listQuick(d)).map((x) => x.name),
      ['Food', 'Fuel'],
      'seeded once, not twice',
    );
    assert.equal((await q.listTransactions(d, c.id)).length, 1);
    assert.equal(((await d.getFirstAsync('PRAGMA user_version')) as any).user_version, SCHEMA_VERSION);
  });

  await test('backups carry quick-adds; an older backup (none) gets the defaults', async () => {
    const d = makeDb();
    await migrate(d);
    await q.addQuick(d, 'Rickshaw', null, null);
    const backup = JSON.parse(JSON.stringify(await q.exportBackup(d)));
    assert.equal(backup.version, 7);
    const d2 = makeDb();
    await migrate(d2);
    await q.restoreBackup(d2, backup);
    assert.deepEqual(
      (await q.listQuick(d2)).map((x) => x.name),
      ['Food', 'Fuel', 'Rickshaw'],
    );

    const old: any = JSON.parse(JSON.stringify(backup));
    delete old.quick_expenses;
    old.version = 2;
    const d3 = makeDb();
    await migrate(d3);
    await q.archiveQuick(d3, (await q.listQuick(d3))[0].id);
    await q.restoreBackup(d3, old);
    assert.deepEqual(
      (await q.listQuick(d3)).map((x) => x.name),
      ['Food', 'Fuel'],
      'defaults come back',
    );
  });

  await test('SCHEMA_VERSION matches what migrate really produces (so the provider key never goes stale)', async () => {
    const d = makeDb();
    await migrate(d);
    assert.equal(((await d.getFirstAsync('PRAGMA user_version')) as any).user_version, SCHEMA_VERSION);
  });

  await test('listCycles orders by start_date, not insertion order (a backup or seed script can insert an older cycle after a newer one)', async () => {
    const d = makeDb();
    await migrate(d);
    const current = (await q.getActiveCycle(d))!;
    // Insert a "previous" cycle after the current one exists, so it gets a HIGHER id despite an EARLIER start_date.
    await d.runAsync(
      'INSERT INTO cycles (start_date, end_date, closed_at) VALUES (?, ?, ?)',
      addDays(current.start_date, -30),
      current.start_date,
      'x',
    );
    const cycles = await q.listCycles(d);
    assert.equal(cycles[0].id, current.id, 'the current cycle (latest start_date) is first regardless of id');
    assert.equal(cycles[0].closed_at, null);
    assert.equal(cycles[1].closed_at, 'x');
  });

  // ---------- All entries: filters, sorting, grouping ----------
  const ledger = async () => {
    const d = makeDb();
    await migrate(d);
    const cyc1 = (await q.getActiveCycle(d))!;
    const cats = Object.fromEntries((await q.listAccounts(d)).map((a) => [a.name, a.id]));
    const bk = Object.fromEntries((await q.listBanks(d)).map((b) => [b.name, b.id]));
    const add = (c: number, t: any) => q.addTransaction(d, c, t);
    // previous cycle
    await add(cyc1.id, {
      type: 'income',
      amount: R(100000),
      source: 'Salary',
      bank_id: bk['Meezan Bank'],
      date: '2026-08-06',
    });
    await add(cyc1.id, {
      type: 'expense',
      amount: R(9000),
      account_id: cats['Others'],
      bank_id: bk['Cash'],
      place: 'Grocery store',
      date: '2026-08-10',
    });
    await q.startNewCycle(d);
    const cyc2 = (await q.getActiveCycle(d))!;
    // current cycle
    await add(cyc2.id, {
      type: 'expense',
      amount: R(2300),
      account_id: cats['Others'],
      bank_id: bk['Cash'],
      place: 'Groceries',
      date: '2026-09-20',
    });
    await add(cyc2.id, {
      type: 'expense',
      amount: R(12500),
      account_id: cats['Credit Card'],
      place: 'Shoes',
      note: 'Eid gift',
      date: '2026-09-20',
    });
    await add(cyc2.id, {
      type: 'expense',
      amount: R(500),
      account_id: cats['Salary'],
      bank_id: bk['NayaPay'],
      place: 'Fuel',
      date: '2026-09-18',
    });
    await add(cyc2.id, { type: 'expense', amount: R(300), date: '2026-09-18' }); // no category, no bank
    await add(cyc2.id, { type: 'card_swipe', amount: R(5000), date: '2026-09-15' }); // Credit → Debit
    await add(cyc2.id, { type: 'card_payment', amount: R(3000), bank_id: bk['Meezan Bank'], date: '2026-09-16' });
    await add(cyc2.id, {
      type: 'income',
      amount: R(50000),
      source: 'Project',
      bank_id: bk['NayaPay'],
      date: '2026-09-10',
    });
    const txs = await q.listAllTransactions(d);
    const ctx = { today: '2026-09-22', currentCycleId: cyc2.id, lastCycleId: cyc1.id };
    const f = (over: Partial<Filters>) => applyFilters(txs, { ...NO_FILTERS, ...over }, ctx);
    return { txs, f, cats, bk, cyc1, cyc2 };
  };

  await test('all entries: no filter shows everything but Credit → Debit moves, across cycles, newest first', async () => {
    const { txs, f } = await ledger();
    assert.equal(txs.length, 9);
    const all = f({});
    assert.equal(all.length, 8);
    assert.ok(!all.some((t) => t.type === 'card_swipe'), 'a Credit → Debit move is not spending');
    const dates = all.map((t) => t.date);
    assert.deepEqual(dates, [...dates].sort().reverse());
    assert.equal(activeFilterCount(NO_FILTERS), 0);
  });

  await test('all entries: type filter', async () => {
    const { f } = await ledger();
    assert.deepEqual(
      f({ type: 'expense' }).map((t) => t.type),
      Array(5).fill('expense'),
    );
    assert.equal(f({ type: 'income' }).length, 2);
    assert.deepEqual(
      f({ type: 'card' })
        .map((t) => t.type)
        .sort(),
      ['card_payment', 'card_swipe', 'expense'],
      'Card = card purchases, Credit → Debit moves and payments',
    );
  });

  await test('all entries: category filter (only expenses have one), incl. "none"', async () => {
    const { f, cats } = await ledger();
    assert.deepEqual(
      f({ categories: [cats['Credit Card']] }).map((t) => t.place),
      ['Shoes'],
    );
    assert.equal(f({ categories: [cats['Others']] }).length, 2);
    assert.equal(
      f({ categories: [cats['Others'], cats['Credit Card']] }).length,
      3,
      'several categories at once are added together',
    );
    assert.equal(f({ categories: [cats['Credit Card'], NONE] }).length, 2, 'category and "none" combine');
    const none = f({ categories: [NONE] });
    assert.equal(none.length, 1);
    assert.equal(none[0].amount, R(300));
    assert.ok(
      f({ categories: [cats['Others']] }).every((t) => t.type === 'expense'),
      'income/card entries never match a category',
    );
  });

  await test('all entries: bank filter (any entry type), incl. "no bank"', async () => {
    const { f, bk } = await ledger();
    assert.equal(f({ banks: [bk['Cash']] }).length, 2); // 2 expenses
    assert.equal(f({ banks: [bk['Meezan Bank']] }).length, 2); // salary income + card payment
    assert.equal(f({ banks: [bk['Meezan Bank'], bk['Cash']] }).length, 4, 'several banks at once');
    const none = f({ banks: [NONE] });
    assert.deepEqual(
      none.map((t) => t.amount).sort((a, b) => a - b),
      [R(300), R(12500)],
    );
  });

  await test('all entries: period filter', async () => {
    const { f, txs } = await ledger();
    assert.equal(f({ period: 'cycle' }).length, 6, 'the Credit → Debit move only shows under Card');
    assert.equal(f({ period: 'last' }).length, 2);
    assert.deepEqual(
      f({ period: '7d' })
        .map((t) => t.date)
        .sort(),
      ['2026-09-16', '2026-09-18', '2026-09-18', '2026-09-20', '2026-09-20'],
    );
    assert.equal(
      f({ period: '30d' }).length,
      6,
      '30 days back from 22 Sep reaches 24 Aug: the August entries are outside it',
    );
    assert.equal(f({ period: 'all' }).length, txs.length - 1);
  });

  await test('all entries: search matches text, notes, banks, categories and amounts (with or without commas)', async () => {
    const { f } = await ledger();
    assert.deepEqual(
      f({ query: 'shoes' }).map((t) => t.place),
      ['Shoes'],
    );
    assert.deepEqual(
      f({ query: 'EID' }).map((t) => t.place),
      ['Shoes'],
      'notes are searched, case-insensitive',
    );
    assert.equal(f({ query: 'nayapay' }).length, 2, 'bank names are searched');
    assert.equal(f({ query: '2,300' }).length, 1);
    assert.equal(f({ query: '2300' }).length, 1);
    assert.equal(f({ query: 'grocer cash' }).length, 2, 'every word must match');
    assert.equal(f({ query: 'zzz' }).length, 0);
    assert.equal(f({ query: '   ' }).length, 8, 'blank search is no filter');
  });

  await test('all entries: filters combine, and sorting works', async () => {
    const { f, cats } = await ledger();
    assert.equal(f({ type: 'expense', period: 'cycle', categories: [cats['Others']], query: 'grocer' }).length, 1);
    assert.deepEqual(
      f({ sort: 'largest' })
        .slice(0, 2)
        .map((t) => t.amount),
      [R(100000), R(50000)],
    );
    const oldest = f({ sort: 'oldest' }).map((t) => t.date);
    assert.deepEqual(oldest, [...oldest].sort());
    assert.equal(
      activeFilterCount({ ...NO_FILTERS, type: 'income', banks: [5], query: 'x', sort: 'largest' }),
      3,
      'sort is not a filter',
    );
  });

  await test('all entries: totals count expenses and income only; days group in order', async () => {
    const { f } = await ledger();
    const all = f({});
    const sum = summarize(all);
    assert.equal(sum.count, 8);
    assert.equal(sum.expenses, R(9000 + 2300 + 12500 + 500 + 300));
    assert.equal(sum.income, R(150000));
    assert.deepEqual(
      summarize(f({ type: 'card' })),
      { count: 3, expenses: R(12500), paid: R(12500), income: 0 },
      'only the card purchase is spending; Credit → Debit and payments are transfers',
    );

    const groups = groupByDate(all);
    assert.deepEqual(
      groups.map((g) => g.date),
      ['2026-09-20', '2026-09-18', '2026-09-16', '2026-09-10', '2026-08-10', '2026-08-06'],
    );
    assert.equal(groups[0].data.length, 2);
    assert.equal(groups[0].spent, R(2300 + 12500));
    assert.equal(groups[1].spent, R(800));
    assert.equal(
      groups.reduce((n, g) => n + g.data.length, 0),
      8,
    );
  });

  await test('category percentages always add up to exactly 100', () => {
    assert.deepEqual(percentShares([1, 1, 1]), [34, 33, 33], 'rounding each alone would give 99');
    assert.deepEqual(percentShares([2, 2, 1, 1, 1, 1, 1, 1]), [20, 20, 10, 10, 10, 10, 10, 10]);
    assert.deepEqual(percentShares([5, 0]), [100, 0]);
    assert.deepEqual(percentShares([0, 0]), [0, 0]);
    for (const vals of [
      [45000, 49700, 32030, 30500],
      [1, 2, 3, 4, 5, 6, 7],
      [999, 1, 1],
    ]) {
      assert.equal(
        percentShares(vals).reduce((a, b) => a + b, 0),
        100,
      );
    }
  });

  await test('split maths: equal, all-on-them and custom always add up to the total', () => {
    assert.deepEqual(splitExpense(R(3000), 2, 'equal'), { others: [R(1000), R(1000)], mine: R(1000) });
    const odd = splitExpense(R(1000), 2, 'equal');
    assert.equal(odd.others[0] + odd.others[1] + odd.mine, R(1000), 'odd paisa are not lost');
    assert.ok(odd.mine >= odd.others[0], 'the odd paisa stays with you');
    const all = splitExpense(1001, 2, 'others');
    assert.deepEqual(all, { others: [501, 500], mine: 0 });
    assert.deepEqual(splitExpense(R(900), 2, 'custom', [R(400), R(100)]), { others: [R(400), R(100)], mine: R(400) });
    assert.equal(splitExpense(R(100), 1, 'custom', [R(150)]).mine, -R(50), 'over-sharing shows as negative');
    assert.deepEqual(splitExpense(R(100), 0, 'equal'), { others: [], mine: R(100) });
  });

  const sharedSetup = async () => {
    const d = makeDb();
    await migrate(d);
    const c = (await q.getActiveCycle(d))!;
    const cats = Object.fromEntries((await q.listAccounts(d)).map((a) => [a.name, a.id]));
    const banks = Object.fromEntries((await q.listBanks(d)).map((b) => [b.name, b.id]));
    const ali = await q.findOrCreatePerson(d, 'Ali');
    const sara = await q.findOrCreatePerson(d, 'Sara');
    return { d, c, cats, banks, ali, sara };
  };

  await test('paying for friends: only your share is spending; they owe you the rest', async () => {
    const { d, c, cats, banks, ali, sara } = await sharedSetup();
    const id = await q.addTransaction(d, c.id, {
      type: 'expense',
      amount: R(3000),
      date: '2026-09-10',
      place: 'Dinner',
      account_id: cats['Others'],
      bank_id: banks['NayaPay'],
      shares: [
        { person_id: ali, amount: R(1000) },
        { person_id: sara, amount: R(1000) },
      ],
    });
    await q.addTransaction(d, c.id, {
      type: 'expense',
      amount: R(500),
      date: '2026-09-10',
      account_id: cats['Others'],
    });

    const t = await q.getCycleTotals(d, c.id);
    assert.equal(t.totalSpent, R(1000 + 500), 'spending is your share plus the other expense');
    assert.equal(t.debitSpent, R(1500));
    assert.equal(t.breakdown.find((b) => b.name === 'Others')!.total, R(1500));
    assert.equal(t.banks.find((b) => b.name === 'NayaPay')!.total, R(1000));
    assert.equal(
      t.breakdown.reduce((s, b) => s + b.total, 0),
      t.totalSpent,
      'categories still sum to the total',
    );
    assert.deepEqual(
      (await q.getDailySpend(d, c.id)).map((r) => r.total),
      [R(1500)],
    );

    const people = await q.listPeople(d);
    assert.equal(people.find((p) => p.id === ali)!.balance, R(1000));
    assert.equal((await q.getDebtTotals(d)).owedToMe, R(2000));

    const tx = (await q.getTransaction(d, id))!;
    assert.equal(tx.amount, R(3000), 'the expense keeps the full amount that left your account');
    assert.equal(tx.shared, R(2000));
    assert.equal(tx.shared_with, 'Ali, Sara');
    assert.equal(myShare(tx), R(1000));
    const linked = (await q.listDebtEntries(d, ali))[0];
    assert.deepEqual([linked.kind, linked.tx_id, linked.date, linked.note], ['lent', id, '2026-09-10', 'Dinner']);
  });

  await test('paying for friends on the credit card: the card owes the full amount, spending is your share', async () => {
    const { d, c, cats, ali } = await sharedSetup();
    await q.addTransaction(d, c.id, {
      type: 'expense',
      amount: R(10000),
      date: '2026-09-11',
      account_id: cats['Credit Card'],
      shares: [{ person_id: ali, amount: R(4000) }],
    });
    const card = await q.getCardSummary(d, c.id);
    assert.equal(card.owed, R(10000), 'the bank charges you for all of it');
    assert.equal(card.online, R(10000));
    assert.equal((await q.getCycleTotals(d, c.id)).creditSpent, R(6000), 'your credit spending is only your part');
  });

  await test('paying for friends: Credit → Debit money spent on friends; an older move with shares keeps them', async () => {
    const { d, c, cats, ali } = await sharedSetup();
    await q.addTransaction(d, c.id, { type: 'card_swipe', amount: R(10000), date: '2026-09-11' });
    await q.addTransaction(d, c.id, {
      type: 'expense',
      amount: R(6000),
      account_id: cats['Credit → Debit'],
      date: '2026-09-12',
      shares: [{ person_id: ali, amount: R(2000) }],
    });
    assert.equal((await q.getCardSummary(d, c.id)).owed, R(10000), 'the card owes the move, not the spending again');
    const t = await q.getCycleTotals(d, c.id);
    assert.deepEqual([t.creditSpent, t.totalSpent, t.totalPaid], [R(4000), R(4000), R(6000)]);

    // Before v8 a swipe itself could carry shares. Editing it keeps them unless they are cleared.
    const old = await q.addTransaction(d, c.id, {
      type: 'card_swipe',
      amount: R(5000),
      date: '2026-09-13',
      shares: [{ person_id: ali, amount: R(1000) }],
    });
    const person = (await q.listPeople(d)).find((p) => p.id === ali)!;
    assert.deepEqual([person.they_owe, person.i_owe], [R(3000), 0]);
    await q.updateTransaction(d, old, { type: 'card_swipe', amount: R(5000), date: '2026-09-13' });
    assert.equal((await q.getTransaction(d, old))!.shared, R(1000), 'shares kept when not passed');
    await q.updateTransaction(d, old, { type: 'card_swipe', amount: R(5000), date: '2026-09-13', shares: [] });
    assert.equal((await q.getTransaction(d, old))!.shared, 0);
    assert.equal((await q.getCycleTotals(d, c.id)).totalSpent, R(4000), 'moves are never spending');
  });

  await test('cycle list: debts belong to the cycle of their expense or their date; totals add up', async () => {
    const { d, c, ali, cats } = await sharedSetup();
    // Dates inside the open cycle, whatever today is.
    const on = (n: number) => addDays(c.start_date, n);
    const tx = await q.addTransaction(d, c.id, {
      type: 'expense',
      amount: R(900),
      date: on(0),
      account_id: cats['Others'],
      shares: [{ person_id: ali, amount: R(300) }],
    });
    await q.addDebtEntry(d, ali, 'got_back', R(100), on(1));
    await q.addDebtEntry(d, ali, 'borrowed', R(50), on(2));
    const first = (await q.getCycle(d, c.id))!;
    const inFirst = await q.listDebtEntriesForCycle(d, first);
    assert.equal(inFirst.length, 3);
    assert.ok(inFirst.some((e) => e.tx_id === tx && e.person_name === 'Ali'));
    assert.deepEqual(summarizeDebts(inFirst), { gave: R(300), gotBack: R(100), borrowed: R(50), paidBack: 0 });

    await q.startNewCycle(d);
    const second = (await q.getActiveCycle(d))!;
    await q.addDebtEntry(d, ali, 'paid_back', R(20), second.start_date);
    const closed = (await q.getCycle(d, c.id))!;
    assert.equal((await q.listDebtEntriesForCycle(d, closed)).length, 3, 'old cycle keeps its own');
    const now = await q.listDebtEntriesForCycle(d, second);
    assert.ok(
      now.every((e) => e.kind === 'paid_back'),
      'the new cycle starts empty of old debts',
    );
  });

  await test('backup round trip keeps cycle lists, debts and stays small', async () => {
    const { d, c, ali, cats } = await sharedSetup();
    for (let i = 0; i < 3000; i++) {
      await q.addTransaction(d, c.id, {
        type: 'expense',
        amount: R(100 + (i % 50)),
        date: '2026-09-10',
        account_id: cats['Others'],
        place: 'Grocery store',
        note: i % 10 === 0 ? 'weekly shop' : null,
        shares: i % 20 === 0 ? [{ person_id: ali, amount: R(30) }] : undefined,
      });
    }
    await q.addDebtEntry(d, ali, 'got_back', R(100), '2026-09-12');
    await q.startNewCycle(d);
    const before = (await q.listDebtEntriesForCycle(d, (await q.getCycle(d, c.id))!)).length;
    const json = JSON.stringify(await q.exportBackup(d));
    assert.ok(json.length < 1_000_000, `3000 entries should be well under 1 MB, got ${json.length} bytes`);

    const { d: d2 } = await sharedSetup();
    await q.restoreBackup(d2, JSON.parse(json));
    const oldCycle = (await q.listCycles(d2)).find((x) => x.closed_at)!;
    assert.equal((await q.listTransactions(d2, oldCycle.id)).length, 3000);
    assert.equal((await q.listDebtEntriesForCycle(d2, oldCycle)).length, before);
  });

  await test('people: they_owe and i_owe are separate sides of the balance', async () => {
    const { d, ali } = await sharedSetup();
    const add = (kind: 'lent' | 'got_back' | 'borrowed' | 'paid_back', amount: number) =>
      q.addDebtEntry(d, ali, kind, R(amount), '2026-09-10');
    await add('lent', 1000);
    await add('got_back', 400);
    await add('borrowed', 700);
    await add('paid_back', 200);
    const p = (await q.getPerson(d, ali))!;
    assert.deepEqual([p.they_owe, p.i_owe, p.balance], [R(600), R(500), R(100)]);
    assert.equal((await q.listPeople(d)).find((x) => x.id === ali)!.i_owe, R(500));
  });

  // ---------- Debts: totals add up, settled history ----------
  const debtDb = async () => {
    const d = makeDb();
    await migrate(d);
    const ali = await q.findOrCreatePerson(d, 'Ali');
    const sara = await q.findOrCreatePerson(d, 'Sara');
    const person = async (id: number) => (await q.getPerson(d, id))!;
    return { d, ali, sara, person };
  };

  await test('debts: each side is its own gross total; an overpayment is clamped, not moved to the other side', async () => {
    const { d, ali, sara, person } = await debtDb();
    await q.addDebtEntry(d, ali, 'lent', R(5000), '2026-10-10');
    await q.addDebtEntry(d, ali, 'borrowed', R(2000), '2026-10-11'); // unrelated to the 5000; both stay open
    await q.addDebtEntry(d, sara, 'lent', R(1000), '2026-10-10');
    await q.addDebtEntry(d, sara, 'got_back', R(1500), '2026-10-12'); // she paid back 500 too much

    const a = await person(ali);
    assert.deepEqual([a.they_owe, a.i_owe, a.balance], [R(5000), R(2000), R(3000)], 'two separate debts, not netted');
    const sa = await person(sara);
    assert.deepEqual(
      [sa.they_owe, sa.i_owe, sa.balance],
      [0, 0, 0],
      'the extra 500 is not owed anywhere unless you record it yourself',
    );

    const people = await q.listPeople(d);
    const t = await q.getDebtTotals(d);
    assert.deepEqual(
      [t.owedToMe, t.iOwe, t.net],
      [
        people.reduce((s, p) => s + p.they_owe, 0),
        people.reduce((s, p) => s + p.i_owe, 0),
        people.reduce((s, p) => s + p.they_owe - p.i_owe, 0),
      ],
      'the totals are plain sums of the same numbers the Debts list shows',
    );
    assert.deepEqual([t.owedToMe, t.iOwe], [R(5000), R(2000)]);
  });

  await test('debts: settling one side never touches the other', async () => {
    const { d, ali, person } = await debtDb();
    await q.addDebtEntry(d, ali, 'lent', R(3000), '2026-10-01');
    await q.addDebtEntry(d, ali, 'borrowed', R(1000), '2026-10-02');

    assert.deepEqual(await q.settleUp(d, ali, 'they', '2026-10-10'), { kind: 'got_back', amount: R(3000) });
    let p = await person(ali);
    assert.deepEqual(
      [p.they_owe, p.i_owe, p.they_settled_on, p.i_settled_on],
      [0, R(1000), '2026-10-10', null],
      'what they owe is settled; what you owe them is untouched',
    );
    assert.deepEqual(
      (await q.listSettlements(d, ali)).map((x) => x.side),
      ['they'],
    );

    assert.deepEqual(await q.settleUp(d, ali, 'me', '2026-10-11'), { kind: 'paid_back', amount: R(1000) });
    p = await person(ali);
    assert.deepEqual([p.they_owe, p.i_owe, p.they_settled_on, p.i_settled_on], [0, 0, '2026-10-10', '2026-10-11']);
    assert.deepEqual(
      (await q.listSettlements(d, ali)).map((x) => x.side).sort(),
      ['me', 'they'],
      'each side has its own settlement',
    );

    assert.equal(await q.settleUp(d, ali, 'they'), null, 'nothing open on that side');
  });

  await test('debts: a side settles on its own when its own running total returns to zero; the other side keeps going', async () => {
    const { d, ali, person } = await debtDb();
    await q.addDebtEntry(d, ali, 'lent', R(1000), '2026-10-01');
    await q.addDebtEntry(d, ali, 'got_back', R(1000), '2026-10-05'); // "they" side comes back to zero
    await q.addDebtEntry(d, ali, 'borrowed', R(400), '2026-10-05'); // "me" side still open, same day

    assert.deepEqual(
      (await q.listSettlements(d, ali)).map((x) => [x.side, x.settled_on]),
      [['they', '2026-10-05']],
    );
    const p = await person(ali);
    assert.deepEqual([p.they_owe, p.i_owe, p.they_settled_on, p.i_settled_on], [0, R(400), '2026-10-05', null]);
  });

  await test('debts: deleting an entry reopens only that side', async () => {
    const { d, ali, person } = await debtDb();
    await q.addDebtEntry(d, ali, 'lent', R(1000), '2026-10-01');
    await q.addDebtEntry(d, ali, 'got_back', R(1000), '2026-10-05');
    await q.addDebtEntry(d, ali, 'borrowed', R(400), '2026-10-05');
    await q.addDebtEntry(d, ali, 'paid_back', R(400), '2026-10-06'); // "me" side settles too, separately
    assert.equal((await q.listSettlements(d, ali)).length, 2);

    const gotBack = (await q.listDebtEntries(d, ali)).find((e) => e.kind === 'got_back')!;
    await q.deleteDebtEntry(d, gotBack.id);
    const settled = await q.listSettlements(d, ali);
    assert.deepEqual(
      settled.map((x) => x.side),
      ['me'],
      'only the "they" stretch reopens; "me" stays settled',
    );
    const p = await person(ali);
    assert.deepEqual([p.they_owe, p.i_owe, p.they_settled_on], [R(1000), 0, null]);
    assert.ok(
      (await q.listDebtEntries(d, ali))
        .filter((e) => e.kind === 'lent' || e.kind === 'got_back')
        .every((e) => e.settlement_id === null),
    );
  });

  await test('debts: a friend’s share of an expense is on the "they" side; settles and reopens independently of a "me" debt', async () => {
    const { d, ali, person } = await debtDb();
    const c = (await q.getActiveCycle(d))!;
    const others = (await q.listAccounts(d)).find((a) => a.name === 'Others')!.id;
    const exp = { type: 'expense' as const, amount: R(1500), account_id: others, date: '2026-10-02', place: 'Dinner' };
    const id = await q.addTransaction(d, c.id, { ...exp, shares: [{ person_id: ali, amount: R(500) }] });
    await q.addDebtEntry(d, ali, 'got_back', R(500), '2026-10-04');
    await q.addDebtEntry(d, ali, 'borrowed', R(900), '2026-10-04'); // a separate "me" debt, should not interact
    assert.deepEqual(
      (await q.listSettlements(d, ali)).map((x) => x.side),
      ['they'],
    );
    assert.equal((await person(ali)).i_owe, R(900), 'the "me" side is untouched by the "they" settlement');

    // Editing the note re-saves the same share: still settled.
    await q.updateTransaction(d, id, { ...exp, note: 'with Ali', shares: [{ person_id: ali, amount: R(500) }] });
    assert.equal((await q.listSettlements(d, ali)).filter((x) => x.side === 'they').length, 1);
    assert.equal((await person(ali)).they_owe, 0);

    // Changing the share means it no longer adds up: the "they" side reopens, clamped (no cross-shift).
    await q.updateTransaction(d, id, { ...exp, shares: [{ person_id: ali, amount: R(400) }] });
    assert.equal((await q.listSettlements(d, ali)).filter((x) => x.side === 'they').length, 0);
    let p = await person(ali);
    assert.deepEqual([p.they_owe, p.i_owe], [0, R(900)]);

    await q.deleteTransaction(d, id);
    p = await person(ali);
    assert.deepEqual([p.they_owe, p.i_owe], [0, R(900)]);
  });

  await test('debts: settling goes by date, so entries added out of order land in the right stretch', async () => {
    const { d, ali, person } = await debtDb();
    // Entered in a different order from when it happened.
    await q.addDebtEntry(d, ali, 'lent', R(2500), '2026-10-15'); // after you were square
    await q.addDebtEntry(d, ali, 'lent', R(3500), '2026-10-08');
    await q.addDebtEntry(d, ali, 'got_back', R(3500), '2026-10-12'); // square on the 12th
    assert.deepEqual(
      (await q.listSettlements(d, ali)).map((x) => [x.side, x.settled_on, x.count, x.lent, x.got_back]),
      [['they', '2026-10-12', 2, R(3500), R(3500)]],
    );
    const p = await person(ali);
    assert.deepEqual([p.they_owe, p.they_settled_on], [R(2500), '2026-10-12']);

    // A backdated entry inside the settled stretch means it was not square after all.
    await q.addDebtEntry(d, ali, 'lent', R(400), '2026-10-10');
    assert.equal((await q.listSettlements(d, ali)).length, 0);
    assert.equal((await person(ali)).they_owe, R(2900));
  });

  await test('debts: only the end of a day counts as square (not halfway through the day)', async () => {
    const { d, ali } = await debtDb();
    await q.addDebtEntry(d, ali, 'lent', R(100), '2026-10-01');
    await q.addDebtEntry(d, ali, 'got_back', R(100), '2026-10-01');
    await q.addDebtEntry(d, ali, 'lent', R(50), '2026-10-01');
    assert.equal((await q.listSettlements(d, ali)).length, 0);
  });

  await test('settle up: either side, in one tap; settling never changes your spending', async () => {
    const { d, ali, sara, person } = await debtDb();
    const c = (await q.getActiveCycle(d))!;
    const others = (await q.listAccounts(d)).find((a) => a.name === 'Others')!.id;
    // Ali owes you: a lent entry, a share of an expense, minus something he already paid back.
    await q.addDebtEntry(d, ali, 'lent', R(3000), '2026-10-01');
    await q.addTransaction(d, c.id, {
      type: 'expense',
      amount: R(1200),
      account_id: others,
      date: '2026-10-02',
      shares: [{ person_id: ali, amount: R(600) }],
    });
    await q.addDebtEntry(d, ali, 'got_back', R(500), '2026-10-03');
    const spentBefore = (await q.getCycleTotals(d, c.id)).totalSpent;

    assert.deepEqual(await q.settleUp(d, ali, 'they', '2026-10-10'), { kind: 'got_back', amount: R(3100) });
    let p = await person(ali);
    assert.deepEqual([p.they_owe, p.they_settled_on], [0, '2026-10-10']);
    const settled = await q.listSettlements(d, ali);
    assert.deepEqual(
      settled.map((x) => [x.side, x.settled_on, x.count, x.lent, x.got_back]),
      [['they', '2026-10-10', 4, R(3600), R(3600)]],
      'everything so far on that side, the share and the squaring payment included',
    );
    const last = (await q.listDebtEntries(d, ali))[0];
    assert.deepEqual([last.kind, last.amount, last.note], ['got_back', R(3100), 'Settled up']);
    assert.equal((await q.getCycleTotals(d, c.id)).totalSpent, spentBefore, 'settling never changes your spending');

    // New entries on that side start fresh.
    await q.addDebtEntry(d, ali, 'lent', R(250), '2026-10-12');
    p = await person(ali);
    assert.deepEqual([p.they_owe, p.i_owe], [R(250), 0]);

    // You owe Sara: settling that side records that you paid her back.
    await q.addDebtEntry(d, sara, 'borrowed', R(900), '2026-10-05');
    assert.deepEqual(await q.settleUp(d, sara, 'me', '2026-10-11'), { kind: 'paid_back', amount: R(900) });
    assert.equal((await person(sara)).i_owe, 0);
    assert.equal((await q.listSettlements(d, sara)).length, 1);
    assert.equal(await q.settleUp(d, sara, 'me'), null, 'already square: nothing recorded');
    assert.equal(await q.settleUp(d, sara, 'they'), null, 'nothing was ever owed on that side');
    assert.equal((await q.getDebtTotals(d)).net, R(250));
  });

  await test('migrate from v8 straight to the current version in one run: settlements land correctly per side', async () => {
    const { d, ali, sara, person } = await debtDb();
    await q.addDebtEntry(d, ali, 'lent', R(700), '2026-09-01');
    await q.addDebtEntry(d, ali, 'got_back', R(700), '2026-09-03'); // square on the "they" side
    await q.addDebtEntry(d, sara, 'borrowed', R(250), '2026-09-02'); // still open
    await d.execAsync(`
      UPDATE debt_entries SET settlement_id = NULL;
      ALTER TABLE debt_entries DROP COLUMN settlement_id;
      DROP TABLE debt_settlements;
      PRAGMA user_version = 8;
    `);
    await migrate(d);
    await migrate(d);
    assert.equal(((await d.getFirstAsync('PRAGMA user_version')) as any).user_version, SCHEMA_VERSION);
    assert.deepEqual(
      (await q.listSettlements(d, ali)).map((x) => [x.side, x.settled_on, x.count]),
      [['they', '2026-09-03', 2]],
    );
    assert.equal((await q.listSettlements(d, sara)).length, 0);
    assert.equal((await person(sara)).i_owe, R(250));
    assert.equal(((await d.getFirstAsync('SELECT COUNT(*) AS n FROM debt_entries')) as any).n, 3, 'nothing lost');
  });

  await test('upgrade v9 -> v10: an existing combined settlement is split by side', async () => {
    const { d, ali, person } = await debtDb();
    await q.addDebtEntry(d, ali, 'lent', R(700), '2026-09-01');
    await q.addDebtEntry(d, ali, 'got_back', R(700), '2026-09-03'); // "they" square
    await q.addDebtEntry(d, ali, 'borrowed', R(400), '2026-09-05');
    await q.addDebtEntry(d, ali, 'paid_back', R(400), '2026-09-06'); // "me" square too, on a later day
    // Drop back to the v9 shape: no side column.
    await d.execAsync(`ALTER TABLE debt_settlements DROP COLUMN side; PRAGMA user_version = 9;`);
    await migrate(d);
    assert.equal(((await d.getFirstAsync('PRAGMA user_version')) as any).user_version, SCHEMA_VERSION);
    assert.deepEqual((await q.listSettlements(d, ali)).map((x) => [x.side, x.settled_on]).sort(), [
      ['me', '2026-09-06'],
      ['they', '2026-09-03'],
    ]);
    const p = await person(ali);
    assert.deepEqual([p.they_owe, p.i_owe], [0, 0]);
  });

  await test('backups carry settled history per side; an older backup (none) gets it filled in on restore', async () => {
    const { d, ali, sara } = await debtDb();
    await q.addDebtEntry(d, ali, 'lent', R(700), '2026-09-01');
    await q.addDebtEntry(d, ali, 'got_back', R(700), '2026-09-03');
    await q.addDebtEntry(d, ali, 'lent', R(100), '2026-09-04');
    await q.addDebtEntry(d, sara, 'borrowed', R(250), '2026-09-02');
    const backup = JSON.parse(JSON.stringify(await q.exportBackup(d)));
    assert.equal(backup.debt_settlements.length, 1);
    assert.equal(backup.debt_settlements[0].side, 'they');

    const d2 = makeDb();
    await migrate(d2);
    await q.restoreBackup(d2, backup);
    // The stretches are rebuilt on restore, so their id numbers may change; what is settled must not.
    const view = async (db: any) =>
      (await q.listDebtEntries(db, ali)).map((e) => ({ ...e, settlement_id: e.settlement_id !== null }));
    assert.deepEqual(await view(d2), await view(d));
    const stretches = async (db: any) => (await q.listSettlements(db, ali)).map(({ id, ...x }) => ({ ...x }));
    assert.deepEqual(await stretches(d2), await stretches(d));

    const v6 = { ...backup, version: 6 };
    v6.debt_settlements = backup.debt_settlements.map(({ side, ...s }: any) => s);
    v6.debt_entries = backup.debt_entries.map(({ settlement_id, ...e }: any) => e);
    const d3 = makeDb();
    await migrate(d3);
    await q.restoreBackup(d3, v6);
    // Ali's "they" side was square on 3 Sep, so that stretch is settled and only the later 100 is open.
    const p = (await q.getPerson(d3, ali))!;
    assert.deepEqual([p.they_owe, p.they_settled_on], [R(100), '2026-09-03']);
    assert.equal((await q.listDebtEntries(d3, ali)).filter((e) => e.settlement_id === null).length, 1);
  });

  await test('bulk category: only expenses move, and none clears it', async () => {
    const { d, c, cats } = await sharedSetup();
    const e1 = await q.addTransaction(d, c.id, {
      type: 'expense',
      amount: R(100),
      date: '2026-09-10',
      account_id: cats['Others'],
    });
    const e2 = await q.addTransaction(d, c.id, { type: 'expense', amount: R(200), date: '2026-09-10' });
    const inc = await q.addTransaction(d, c.id, { type: 'income', amount: R(900), date: '2026-09-10' });
    await q.setCategoryOnTransactions(d, [e1, e2, inc], cats['Credit Card']);
    assert.equal((await q.getTransaction(d, e1))!.account_id, cats['Credit Card']);
    assert.equal((await q.getTransaction(d, e2))!.account_id, cats['Credit Card']);
    assert.equal((await q.getTransaction(d, inc))!.account_id, null, 'income has no category');
    await q.setCategoryOnTransactions(d, [e1], null);
    assert.equal((await q.getTransaction(d, e1))!.account_id, null);
  });

  await test('paying for friends: editing replaces the shares, leaving them out keeps them, other types drop them', async () => {
    const { d, c, cats, ali, sara } = await sharedSetup();
    const base = { type: 'expense' as const, amount: R(600), date: '2026-09-12', account_id: cats['Others'] };
    const id = await q.addTransaction(d, c.id, { ...base, shares: [{ person_id: ali, amount: R(200) }] });

    await q.updateTransaction(d, id, { ...base, amount: R(900), note: 'edited' });
    assert.equal((await q.getTransaction(d, id))!.shared, R(200), 'shares untouched when not passed');

    await q.updateTransaction(d, id, { ...base, shares: [{ person_id: sara, amount: R(300) }] });
    assert.deepEqual(
      (await q.listShares(d, id)).map((s) => [s.name, s.amount]),
      [['Sara', R(300)]],
    );
    assert.equal((await q.listPeople(d)).find((p) => p.id === ali)!.balance, 0);

    await assert.rejects(
      q.updateTransaction(d, id, { ...base, shares: [{ person_id: ali, amount: R(700) }] }),
      /more than the amount/,
    );
    assert.equal((await q.getTransaction(d, id))!.shared, R(300), 'a rejected edit changes nothing');

    await q.updateTransaction(d, id, { ...base, shares: [] });
    assert.equal((await q.getTransaction(d, id))!.shared, 0);

    await q.updateTransaction(d, id, { ...base, shares: [{ person_id: ali, amount: R(100) }] });
    await q.updateTransaction(d, id, { type: 'income', amount: R(600), date: '2026-09-12' });
    assert.equal((await q.listDebtEntries(d, ali)).length, 0, 'an entry that is no longer an expense has no shares');
  });

  await test('totals: total paid counts everything entered, my spending leaves out friends’ shares', async () => {
    const { d, c, cats, ali } = await sharedSetup();
    await q.addTransaction(d, c.id, {
      type: 'expense',
      amount: R(3000),
      date: '2026-09-10',
      account_id: cats['Others'],
      shares: [{ person_id: ali, amount: R(1200) }],
    });
    await q.addTransaction(d, c.id, {
      type: 'expense',
      amount: R(500),
      date: '2026-09-11',
      account_id: cats['Others'],
    });
    const t = await q.getCycleTotals(d, c.id);
    assert.equal(t.totalPaid, R(3500));
    assert.equal(t.totalSpent, R(2300));
    assert.equal(t.sharedOut, R(1200));
  });

  await test('tags: create, tag many entries at once, totals per cycle, any-of filter, delete, backup', async () => {
    const { d, c, cats, ali } = await sharedSetup();
    const base = { type: 'expense' as const, date: '2026-09-10', account_id: cats['Others'] };
    const trip = await q.findOrCreateTag(d, 'Trip');
    assert.equal(await q.findOrCreateTag(d, ' trip '), trip, 'names match regardless of case and spaces');
    const food = await q.findOrCreateTag(d, 'Food');

    const a = await q.addTransaction(d, c.id, {
      ...base,
      amount: R(3000),
      tags: [trip],
      shares: [{ person_id: ali, amount: R(1000) }],
    });
    const b = await q.addTransaction(d, c.id, { ...base, amount: R(500) });
    const e = await q.addTransaction(d, c.id, { ...base, amount: R(200) });
    await q.setTagOnTransactions(d, [b, e], trip, true);
    await q.setTagOnTransactions(d, [b], food, true);

    let totals = await q.getTagTotals(d, c.id);
    assert.deepEqual(
      totals.map((t) => [t.name, t.count, t.paid, t.mine]),
      [
        ['Trip', 3, R(3700), R(2700)],
        ['Food', 1, R(500), R(500)],
      ],
    );

    const all = await q.listAllTransactions(d);
    const ctx = { today: '2026-09-30', currentCycleId: c.id, lastCycleId: null };
    const both = applyFilters(all, { ...NO_FILTERS, tags: [trip, food] }, ctx);
    assert.equal(both.length, 3, 'several tags match entries carrying any of them, each entry once');
    assert.ok(both.some((t) => t.id === b));
    assert.deepEqual(
      applyFilters(all, { ...NO_FILTERS, tags: [food] }, ctx).map((t) => t.id),
      [b],
    );
    assert.equal(activeFilterCount({ ...NO_FILTERS, tags: [trip] }), 1);
    const onlyTrip = summarize(applyFilters(all, { ...NO_FILTERS, tags: [trip] }, ctx));
    assert.deepEqual([onlyTrip.paid, onlyTrip.expenses], [R(3700), R(2700)]);
    assert.deepEqual((await q.getTransaction(d, a))!.tag_names, 'Trip');

    const backup = JSON.parse(JSON.stringify(await q.exportBackup(d)));
    const d2 = makeDb();
    await migrate(d2);
    await q.restoreBackup(d2, backup);
    assert.deepEqual(await q.getTagTotals(d2, c.id), totals, 'tags survive a backup and restore');

    await q.setTagOnTransactions(d, [b, e], trip, false);
    assert.equal((await q.getTransaction(d, b))!.tag_names, 'Food');
    await q.updateTransaction(d, a, { ...base, amount: R(3000), tags: [] });
    assert.equal((await q.getTransaction(d, a))!.tag_ids, null);
    await q.setTagOnTransactions(d, [a], food, true);
    await q.deleteTag(d, food);
    totals = await q.getTagTotals(d, c.id);
    assert.equal(totals.length, 0);
    await q.deleteTransaction(d, e);
    assert.equal((await q.listTags(d)).length, 1, 'deleting an entry keeps the tags');
  });

  await test('paying for friends: deleting the expense removes their debts; paying back settles them', async () => {
    const { d, c, cats, ali } = await sharedSetup();
    const id = await q.addTransaction(d, c.id, {
      type: 'expense',
      amount: R(800),
      date: '2026-09-13',
      account_id: cats['Others'],
      shares: [{ person_id: ali, amount: R(300) }],
    });
    await q.addDebtEntry(d, ali, 'got_back', R(300), '2026-09-14');
    assert.equal((await q.getPerson(d, ali))!.balance, 0, 'settled once they pay back');
    assert.equal((await q.getCycleTotals(d, c.id)).totalSpent, R(500), 'paying back does not change spending');

    await q.deleteTransaction(d, id);
    assert.equal((await q.listDebtEntries(d, ali)).filter((e) => e.kind === 'lent').length, 0);
    // Their "got back" entry is still there, but the "they" side it belonged to just clamps to zero: a side
    // never goes negative and is never moved onto the other one, so this stays "they owe 0", not "you owe them".
    assert.deepEqual([(await q.getPerson(d, ali))!.they_owe, (await q.getPerson(d, ali))!.balance], [0, 0]);
  });

  await test('paying for friends: list totals, CSV columns and backup all use your share', async () => {
    const { d, c, cats, ali } = await sharedSetup();
    await q.addTransaction(d, c.id, {
      type: 'expense',
      amount: R(2000),
      date: '2026-09-15',
      account_id: cats['Others'],
      shares: [{ person_id: ali, amount: R(500) }],
    });
    const txs = await q.listAllTransactions(d);
    assert.equal(summarize(txs).expenses, R(1500));
    assert.equal(groupByDate(txs)[0].spent, R(1500));
    assert.equal(
      applyFilters(
        txs,
        { ...NO_FILTERS, query: 'ali' },
        { today: '2026-09-22', currentCycleId: c.id, lastCycleId: null },
      ).length,
      1,
    );

    const backup = JSON.parse(JSON.stringify(await q.exportBackup(d)));
    const d2 = makeDb();
    await migrate(d2);
    await q.restoreBackup(d2, backup);
    const c2 = (await q.getActiveCycle(d2))!;
    assert.equal((await q.getCycleTotals(d2, c2.id)).totalSpent, R(1500), 'shares survive a restore');
    assert.equal((await q.getDebtTotals(d2)).owedToMe, R(500));

    const old = JSON.parse(JSON.stringify(backup));
    for (const row of old.debt_entries) delete row.tx_id;
    const d3 = makeDb();
    await migrate(d3);
    await q.restoreBackup(d3, old);
    assert.equal((await q.getDebtTotals(d3)).owedToMe, R(500), 'a backup without links still restores');
  });

  await test('upgrade v5 -> v6 keeps existing debts as plain entries', async () => {
    const d = makeDb();
    await migrate(d);
    const ali = await q.findOrCreatePerson(d, 'Ali');
    await q.addDebtEntry(d, ali, 'lent', R(100), '2026-09-01');
    await d.execAsync('DROP INDEX idx_debt_tx; ALTER TABLE debt_entries DROP COLUMN tx_id; PRAGMA user_version = 5;');
    await migrate(d);
    const [e] = await q.listDebtEntries(d, ali);
    assert.deepEqual([e.amount, e.tx_id], [R(100), null]);
    assert.equal(((await d.getFirstAsync('PRAGMA user_version')) as any).user_version, SCHEMA_VERSION);
  });

  console.log(`\n${passed} passed`);
})();
