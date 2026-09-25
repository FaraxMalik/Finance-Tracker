import type { SQLiteDatabase } from 'expo-sqlite';

import { addDays, todayISO } from '@/lib/dates';

import * as q from '@/db/queries';

const R = (n: number) => Math.round(n * 100);

/** Dev-only: fills the database with realistic sample data for previews and screenshots. */
export async function seedDemo(db: SQLiteDatabase) {
  const cycle = (await q.getActiveCycle(db))!;
  const accounts = Object.fromEntries((await q.listAccounts(db)).map((a) => [a.name, a.id]));
  const bank = Object.fromEntries((await q.listBanks(db)).map((b) => [b.name, b.id]));
  const today = todayISO();
  const day = (n: number) => {
    const d = addDays(cycle.start_date, n);
    return d > today ? today : d;
  };

  await q.setSetting(db, 'credit_limit', String(R(250000)));
  await q.setSetting(db, 'card_opening_balance', String(R(35000)));

  // A closed previous cycle for the History tab.
  const prev = await db.runAsync(
    `INSERT INTO cycles (start_date, end_date, closed_at, snap_card_owed, snap_owed_to_me, snap_i_owe)
     VALUES (?, ?, ?, ?, ?, ?)`,
    addDays(cycle.start_date, -30),
    cycle.start_date,
    new Date().toISOString(),
    R(35000),
    R(12000),
    R(5000),
  );
  const prevId = prev.lastInsertRowId;
  const back = (n: number) => addDays(cycle.start_date, -30 + n);
  for (const t of [
    { type: 'income', amount: R(185000), source: 'Salary', bank_id: bank['Meezan Bank'], date: back(0) },
    {
      type: 'expense',
      amount: R(42000),
      account_id: accounts['Salary'],
      bank_id: bank['Meezan Bank'],
      place: 'Rent',
      date: back(2),
    },
    { type: 'expense', amount: R(18500), account_id: accounts['Credit Card'], place: 'Groceries', date: back(8) },
    {
      type: 'expense',
      amount: R(9200),
      account_id: accounts['Others'],
      bank_id: bank['NayaPay'],
      place: 'Fuel',
      date: back(14),
    },
    { type: 'expense', amount: R(14300), account_id: accounts['Credit Card'], place: 'Electronics', date: back(20) },
    { type: 'card_payment', amount: R(30000), bank_id: bank['Meezan Bank'], date: back(24) },
  ] as const) {
    await q.addTransaction(db, prevId, t);
  }

  const add = (t: q.TxInput) => q.addTransaction(db, cycle.id, t);
  await add({ type: 'income', amount: R(185000), source: 'Salary', bank_id: bank['Meezan Bank'], date: day(0) });
  await add({ type: 'income', amount: R(32000), source: 'Project', bank_id: bank['NayaPay'], date: day(9) });
  await add({
    type: 'expense',
    amount: R(42000),
    account_id: accounts['Salary'],
    bank_id: bank['Meezan Bank'],
    place: 'Rent',
    date: day(1),
  });
  await add({
    type: 'expense',
    amount: R(6400),
    account_id: accounts['Others'],
    bank_id: bank['Cash'],
    place: 'Grocery store',
    date: day(2),
  });
  await add({
    type: 'expense',
    amount: R(1850),
    account_id: accounts['Salary'],
    bank_id: bank['SadaPay'],
    place: 'Lunch with team',
    date: day(3),
  });
  await add({ type: 'expense', amount: R(12500), account_id: accounts['Credit Card'], place: 'Shoes', date: day(4) });
  await add({
    type: 'expense',
    amount: R(4200),
    account_id: accounts['Others'],
    bank_id: bank['NayaPay'],
    place: 'Fuel',
    date: day(5),
  });
  await add({
    type: 'expense',
    amount: R(980),
    account_id: accounts['Others'],
    bank_id: bank['Cash'],
    place: 'Chai & snacks',
    date: day(6),
  });
  await add({
    type: 'expense',
    amount: R(23900),
    account_id: accounts['Credit Card'],
    place: 'Phone repair',
    date: day(8),
  });
  await add({
    type: 'expense',
    amount: R(3100),
    account_id: accounts['Salary'],
    bank_id: bank['Faysal Bank'],
    place: 'Electricity bill',
    date: day(9),
  });
  await add({ type: 'card_swipe', amount: R(40000), fee: R(1200), bank_id: bank['Meezan Bank'], date: day(10) });
  await add({ type: 'card_withdrawal', amount: R(15000), fee: R(450), bank_id: bank['Cash'], date: day(11) });
  await add({
    type: 'expense',
    amount: R(2750),
    account_id: accounts['Salary'],
    bank_id: bank['SadaPay'],
    place: 'Pharmacy',
    date: day(11),
  });
  await add({
    type: 'expense',
    amount: R(8600),
    account_id: accounts['Credit Card'],
    place: 'Online order',
    date: day(12),
  });
  await add({ type: 'card_payment', amount: R(25000), bank_id: bank['Meezan Bank'], date: day(13) });
  await add({
    type: 'expense',
    amount: R(1450),
    account_id: accounts['Others'],
    bank_id: bank['Cash'],
    place: 'Rickshaw',
    date: day(14),
  });
  await add({
    type: 'expense',
    amount: R(5200),
    account_id: accounts['Others'],
    bank_id: bank['NayaPay'],
    place: 'Dinner out',
    date: day(15),
  });
  await add({
    type: 'expense',
    amount: R(2300),
    account_id: accounts['Others'],
    bank_id: bank['Cash'],
    place: 'Groceries',
    date: day(16),
  });

  const ali = await q.findOrCreatePerson(db, 'Ali Raza');
  const sara = await q.findOrCreatePerson(db, 'Sara Khan');
  const usman = await q.findOrCreatePerson(db, 'Usman');
  await q.addDebtEntry(db, ali, 'lent', R(15000), day(2), 'For the laptop deposit');
  await q.addDebtEntry(db, ali, 'got_back', R(3000), day(9));
  await q.addDebtEntry(db, sara, 'borrowed', R(5000), day(6), 'Dinner and cab');
  await q.addDebtEntry(db, usman, 'lent', R(3500), day(12));
}
