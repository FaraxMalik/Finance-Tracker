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
  type Filters,
} from '@/lib/ledger';
import { currentCycleStart, nextBoundary, nominalEnd, cycleProgress } from '@/lib/cycle';
import { toPaisa, formatPKR } from '@/lib/money';
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
      accts.map((a) => [a.name, a.kind]),
      [
        ['Credit Card', 'credit'],
        ['Salary', 'debit'],
        ['Others', 'debit'],
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
  await add({ type: 'expense', amount: R(4000), account_id: byName['Credit Card'], place: 'Shoes' }); // credit
  await add({ type: 'card_swipe', amount: R(20000), fee: R(600), account_id: byName['Salary'] }); // owed +20000, fee 600 credit spend
  await add({ type: 'card_payment', amount: R(10000), account_id: byName['Salary'] }); // owed -10000

  await test('cycle totals: debit / credit / income, swipes & payments not spending', async () => {
    const t = await q.getCycleTotals(db, cycle.id);
    assert.equal(t.debitSpent, R(2800));
    assert.equal(t.creditSpent, R(4000) + R(600));
    assert.equal(t.totalSpent, R(2800) + R(4600));
    assert.equal(t.income, R(90000));
    assert.equal(t.cardPayments, R(10000));
    assert.equal(t.swipeFees, R(600));
  });

  await test('category breakdown: individual totals, fee on the card, sums to total', async () => {
    const t = await q.getCycleTotals(db, cycle.id);
    const by = Object.fromEntries(t.breakdown.map((c) => [c.name, c.total]));
    assert.deepEqual(by, {
      'Credit Card': R(4000) + R(600), // purchase + swipe fee
      Others: R(2000) + R(500), // two categorised expenses
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
        ['Cash', R(2000)],
        ['NayaPay', R(500)],
      ],
    );
  });

  await test('card owed = opening + purchases + swipes - payments; limit maths', async () => {
    const c = await q.getCardSummary(db, cycle.id);
    assert.equal(c.owed, R(5000 + 4000 + 20000 - 10000));
    assert.equal(c.available, R(100000 - 19000));
    assert.ok(Math.abs(c.usedFraction - 0.19) < 1e-9);
    assert.equal(c.swipes, R(20000));
    assert.equal(c.payments, R(10000));
    assert.equal(c.online, R(4000), 'the credit-card expense entered like any other expense is the Online total');
  });

  await test('daily spend groups expenses + fees only', async () => {
    const d = await q.getDailySpend(db, cycle.id);
    assert.deepEqual(
      d.map((x) => ({ ...x })),
      [{ date: '2026-09-10', total: R(2000 + 500 + 300 + 4000 + 600) }],
    );
  });

  await test('card activity list: a Home expense filed under Credit Card shows up as a card entry', async () => {
    const list = await q.listCardTransactions(db, cycle.id);
    assert.equal(list.length, 3); // credit purchase, swipe, payment
    const online = list.find((t) => t.type === 'expense')!;
    assert.equal(online.account_name, 'Credit Card');
    assert.equal(online.amount, R(4000));
    // A normal debit expense must NOT appear on the Credit screen.
    assert.ok(!list.some((t) => t.account_name === 'Others'));
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
    assert.equal(closed[0].totalSpent, R(7400));
    assert.equal(closed[0].snap_card_owed, R(19000));
    assert.equal(closed[0].snap_owed_to_me, R(4000));
    assert.equal(closed[0].snap_i_owe, R(2500));
    const fresh = (await q.getActiveCycle(db))!;
    assert.notEqual(fresh.id, cycle.id);
    const t = await q.getCycleTotals(db, fresh.id);
    assert.equal(t.totalSpent, 0);
    assert.equal(t.income, 0);
    const c = await q.getCardSummary(db, fresh.id);
    assert.equal(c.owed, R(19000), 'card debt carries over');
    assert.equal((await q.getDebtTotals(db)).owedToMe, R(4000), 'debts carry over');
    // old cycle report is unchanged
    assert.equal((await q.listTransactions(db, cycle.id)).length, 8);
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
    assert.equal(old.totalSpent, R(7400));
    assert.equal((await q.getCardSummary(db2, b.id)).owed, R(19000));
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
    assert.equal(v2.version, 4);
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

  await test('card withdrawal: raises card owed, only its fee is spending, appears in card activity + daily spend', async () => {
    const d = makeDb();
    await migrate(d);
    const c = (await q.getActiveCycle(d))!;
    await q.setSetting(d, 'card_opening_balance', String(R(1000)));
    await q.addTransaction(d, c.id, { type: 'card_withdrawal', amount: R(5000), fee: R(150), date: '2026-09-10' });
    await q.addTransaction(d, c.id, { type: 'card_swipe', amount: R(2000), fee: R(60), date: '2026-09-10' });
    await q.addTransaction(d, c.id, { type: 'card_payment', amount: R(3000), date: '2026-09-11' });

    const card = await q.getCardSummary(d, c.id);
    assert.equal(card.owed, R(1000 + 5000 + 2000 - 3000));
    assert.equal(card.withdrawals, R(5000));
    assert.equal(card.swipes, R(2000));
    assert.equal(card.payments, R(3000));
    assert.equal(card.swipeFees, R(210));

    const t = await q.getCycleTotals(d, c.id);
    assert.equal(t.totalSpent, R(210), 'only the fees are spending');
    assert.equal(t.creditSpent, R(210));
    assert.equal(
      t.breakdown.find((x) => x.name === 'Credit Card')!.total,
      R(210),
      'fees land on the Credit Card category',
    );
    assert.equal(
      t.breakdown.reduce((a, x) => a + x.total, 0),
      t.totalSpent,
    );
    assert.equal((await q.listCardTransactions(d, c.id)).length, 3);
    assert.deepEqual(
      (await q.getDailySpend(d, c.id)).map((x) => ({ ...x })),
      [{ date: '2026-09-10', total: R(210) }],
    );
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
    await q.addTransaction(d, c.id, { type: 'card_withdrawal', amount: R(50), date: '2026-09-12' });
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
    assert.equal(backup.version, 4);
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
    await add(cyc2.id, {
      type: 'card_withdrawal',
      amount: R(5000),
      fee: R(150),
      bank_id: bk['Cash'],
      date: '2026-09-15',
    });
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

  await test('all entries: no filter shows everything across cycles, newest first', async () => {
    const { txs, f } = await ledger();
    assert.equal(txs.length, 9);
    const all = f({});
    assert.equal(all.length, 9);
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
      ['card_payment', 'card_withdrawal'],
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
    assert.equal(f({ banks: [bk['Cash']] }).length, 3); // 2 expenses + the withdrawal
    assert.equal(f({ banks: [bk['Meezan Bank']] }).length, 2); // salary income + card payment
    assert.equal(f({ banks: [bk['Meezan Bank'], bk['Cash']] }).length, 5, 'several banks at once');
    const none = f({ banks: [NONE] });
    assert.deepEqual(
      none.map((t) => t.amount).sort((a, b) => a - b),
      [R(300), R(12500)],
    );
  });

  await test('all entries: period filter', async () => {
    const { f, txs } = await ledger();
    assert.equal(f({ period: 'cycle' }).length, 7);
    assert.equal(f({ period: 'last' }).length, 2);
    assert.deepEqual(
      f({ period: '7d' })
        .map((t) => t.date)
        .sort(),
      ['2026-09-16', '2026-09-18', '2026-09-18', '2026-09-20', '2026-09-20'],
    );
    assert.equal(
      f({ period: '30d' }).length,
      7,
      '30 days back from 22 Sep reaches 24 Aug: the August entries are outside it',
    );
    assert.equal(f({ period: 'all' }).length, txs.length);
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
    assert.equal(f({ query: '   ' }).length, 9, 'blank search is no filter');
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
    assert.equal(sum.count, 9);
    assert.equal(sum.expenses, R(9000 + 2300 + 12500 + 500 + 300));
    assert.equal(sum.income, R(150000));
    assert.deepEqual(
      summarize(f({ type: 'card' })),
      { count: 2, expenses: 0, paid: 0, income: 0 },
      'card entries are transfers, so not summed',
    );

    const groups = groupByDate(all);
    assert.deepEqual(
      groups.map((g) => g.date),
      ['2026-09-20', '2026-09-18', '2026-09-16', '2026-09-15', '2026-09-10', '2026-08-10', '2026-08-06'],
    );
    assert.equal(groups[0].data.length, 2);
    assert.equal(groups[0].spent, R(2300 + 12500));
    assert.equal(groups[1].spent, R(800));
    assert.equal(
      groups.reduce((n, g) => n + g.data.length, 0),
      9,
    );
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
    assert.equal(card.creditSpent, R(6000), 'your credit spending is only your part');
    assert.equal((await q.getCycleTotals(d, c.id)).creditSpent, R(6000));
  });

  await test('paying for friends on a swipe or withdrawal: shares become debts, the card still owes it all', async () => {
    const { d, c, ali } = await sharedSetup();
    const swipe = await q.addTransaction(d, c.id, {
      type: 'card_swipe',
      amount: R(10000),
      fee: R(200),
      date: '2026-09-11',
      shares: [{ person_id: ali, amount: R(3000) }],
    });
    await q.addTransaction(d, c.id, {
      type: 'card_withdrawal',
      amount: R(5000),
      date: '2026-09-12',
      shares: [{ person_id: ali, amount: R(1000) }],
    });
    assert.equal((await q.getCardSummary(d, c.id)).owed, R(15000));
    assert.equal((await q.getTransaction(d, swipe))!.shared, R(3000));
    const person = (await q.listPeople(d)).find((p) => p.id === ali)!;
    assert.deepEqual([person.balance, person.they_owe, person.i_owe], [R(4000), R(4000), 0]);
    assert.equal((await q.getCycleTotals(d, c.id)).totalSpent, R(200), 'only the fee is spending');

    await q.updateTransaction(d, swipe, { type: 'card_swipe', amount: R(10000), fee: R(200), date: '2026-09-11' });
    assert.equal((await q.getTransaction(d, swipe))!.shared, R(3000), 'shares kept when not passed');
    await q.updateTransaction(d, swipe, { type: 'card_swipe', amount: R(10000), date: '2026-09-11', shares: [] });
    assert.equal((await q.getTransaction(d, swipe))!.shared, 0);
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
    assert.equal((await q.getPerson(d, ali))!.balance, -R(300), 'only their payment is left, so you owe it back');
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
