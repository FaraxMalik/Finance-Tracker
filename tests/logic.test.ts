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
import { activeFilterCount, applyFilters, groupByDate, NO_FILTERS, summarize, type Filters } from '@/lib/ledger';
import { currentCycleStart, nextBoundary, nominalEnd, cycleProgress } from '@/lib/cycle';
import { toPaisa, formatPKR } from '@/lib/money';
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
    assert.equal(v2.version, 3);
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
      5,
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
    assert.equal(((await d.getFirstAsync('PRAGMA user_version')) as any).user_version, 5);
  });

  await test('backups carry quick-adds; an older backup (none) gets the defaults', async () => {
    const d = makeDb();
    await migrate(d);
    await q.addQuick(d, 'Rickshaw', null, null);
    const backup = JSON.parse(JSON.stringify(await q.exportBackup(d)));
    assert.equal(backup.version, 3);
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
      f({ category: cats['Credit Card'] }).map((t) => t.place),
      ['Shoes'],
    );
    assert.equal(f({ category: cats['Others'] }).length, 2);
    const none = f({ category: 'none' });
    assert.equal(none.length, 1);
    assert.equal(none[0].amount, R(300));
    assert.ok(
      f({ category: cats['Others'] }).every((t) => t.type === 'expense'),
      'income/card entries never match a category',
    );
  });

  await test('all entries: bank filter (any entry type), incl. "no bank"', async () => {
    const { f, bk } = await ledger();
    assert.equal(f({ bank: bk['Cash'] }).length, 3); // 2 expenses + the withdrawal
    assert.equal(f({ bank: bk['Meezan Bank'] }).length, 2); // salary income + card payment
    const none = f({ bank: 'none' });
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
    assert.equal(f({ type: 'expense', period: 'cycle', category: cats['Others'], query: 'grocer' }).length, 1);
    assert.deepEqual(
      f({ sort: 'largest' })
        .slice(0, 2)
        .map((t) => t.amount),
      [R(100000), R(50000)],
    );
    const oldest = f({ sort: 'oldest' }).map((t) => t.date);
    assert.deepEqual(oldest, [...oldest].sort());
    assert.equal(
      activeFilterCount({ ...NO_FILTERS, type: 'income', bank: 5, query: 'x', sort: 'largest' }),
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
      { count: 2, expenses: 0, income: 0 },
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

  console.log(`\n${passed} passed`);
})();
