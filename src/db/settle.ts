import type { SQLiteDatabase } from 'expo-sqlite';

/** lent / paid_back move the balance towards "they owe me"; borrowed / got_back move it the other way. */
export const SIGNED_AMOUNT = (d: string) =>
  `CASE ${d}.kind WHEN 'lent' THEN ${d}.amount WHEN 'paid_back' THEN ${d}.amount ELSE -${d}.amount END`;

const SIGN = { lent: 1, paid_back: 1, borrowed: -1, got_back: -1 } as const;

/**
 * Works out each person's settled history from their entries. Runs inside the caller's transaction.
 *
 * Going through a person's entries by date, every day on which the running balance comes back to zero closes a
 * settled stretch: those entries become their past history and whatever comes after starts fresh. It is rebuilt
 * from the entries every time, so an entry added for an earlier date, an edited share or a deleted entry always
 * lands in the right stretch (and a stretch that no longer adds up to zero simply stops being settled).
 * Leave `personIds` out to rebuild everyone.
 */
export async function settleDebts(db: SQLiteDatabase, personIds?: number[]) {
  const ids = personIds ?? (await db.getAllAsync<{ id: number }>('SELECT id FROM people')).map((p) => p.id);
  for (const personId of new Set(ids)) {
    await db.runAsync('UPDATE debt_entries SET settlement_id = NULL WHERE person_id = ?', personId);
    await db.runAsync('DELETE FROM debt_settlements WHERE person_id = ?', personId);

    const entries = await db.getAllAsync<{ id: number; kind: keyof typeof SIGN; amount: number; date: string }>(
      'SELECT id, kind, amount, date FROM debt_entries WHERE person_id = ? ORDER BY date, id',
      personId,
    );
    let running = 0;
    let stretch: number[] = [];
    for (const [i, e] of entries.entries()) {
      running += SIGN[e.kind] * e.amount;
      stretch.push(e.id);
      const endOfDay = entries[i + 1]?.date !== e.date;
      if (!endOfDay || running !== 0) continue;
      const res = await db.runAsync(
        'INSERT INTO debt_settlements (person_id, settled_on, created_at) VALUES (?, ?, ?)',
        personId,
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
}
