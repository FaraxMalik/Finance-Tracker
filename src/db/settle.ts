import type { SQLiteDatabase } from 'expo-sqlite';

/** Which side of a person's ledger: what they owe you, or what you owe them. Settled and tracked separately. */
export type DebtSide = 'they' | 'me';

/** The entry kinds that make up each side: one adds to it, the other brings it down. */
const SIDE_KINDS: Record<DebtSide, { up: 'lent' | 'borrowed'; down: 'got_back' | 'paid_back' }> = {
  they: { up: 'lent', down: 'got_back' },
  me: { up: 'borrowed', down: 'paid_back' },
};

/**
 * Works out a person's settled history, one side at a time. Runs inside the caller's transaction.
 *
 * What they owe you (lent / got back) and what you owe them (borrowed / paid back) are kept apart: you might lend
 * for one thing and borrow for another, and the two shouldn't cancel each other out. For each side on its own,
 * going through its entries by date, every day its running total comes back to zero closes a settled stretch:
 * those entries become that side's past and whatever comes after starts fresh. It is rebuilt from the entries
 * every time, so a backdated entry, an edited share or a deleted entry always lands in the right stretch, and a
 * stretch that no longer adds up to zero simply reopens. Leave `personIds` out to rebuild everyone.
 */
export async function settleDebts(db: SQLiteDatabase, personIds?: number[]) {
  const ids = personIds ?? (await db.getAllAsync<{ id: number }>('SELECT id FROM people')).map((p) => p.id);
  for (const personId of new Set(ids)) {
    await db.runAsync('UPDATE debt_entries SET settlement_id = NULL WHERE person_id = ?', personId);
    await db.runAsync('DELETE FROM debt_settlements WHERE person_id = ?', personId);
    await settleSide(db, personId, 'they');
    await settleSide(db, personId, 'me');
  }
}

async function settleSide(db: SQLiteDatabase, personId: number, side: DebtSide) {
  const { up, down } = SIDE_KINDS[side];
  const entries = await db.getAllAsync<{ id: number; kind: string; amount: number; date: string }>(
    'SELECT id, kind, amount, date FROM debt_entries WHERE person_id = ? AND kind IN (?, ?) ORDER BY date, id',
    personId,
    up,
    down,
  );
  let running = 0;
  let stretch: number[] = [];
  for (const [i, e] of entries.entries()) {
    running += e.kind === up ? e.amount : -e.amount;
    stretch.push(e.id);
    const endOfDay = entries[i + 1]?.date !== e.date;
    if (!endOfDay || running !== 0) continue;
    const res = await db.runAsync(
      'INSERT INTO debt_settlements (person_id, side, settled_on, created_at) VALUES (?, ?, ?, ?)',
      personId,
      side,
      e.date,
      new Date().toISOString(),
    );
    await db.runAsync(
      `UPDATE debt_entries SET settlement_id = ? WHERE id IN (${stretch.map(() => '?').join(', ')})`,
      res.lastInsertRowId,
      ...stretch,
    );
    stretch = [];
  }
}
