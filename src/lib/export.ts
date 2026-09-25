import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import type { Tx } from '@/db/queries';
import { fromPaisa } from '@/lib/money';
import { TYPE_LABEL, txTitle } from '@/components/tx-row';

const escape = (v: string | number | null | undefined) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per transaction, oldest first, ready for a spreadsheet. */
export function transactionsToCsv(txs: Tx[]): string {
  const header = ['Date', 'Type', 'Where / Source', 'Category', 'Bank', 'Amount (Rs)', 'Fee (Rs)', 'Note'];
  const rows = [...txs]
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id)
    .map((t) => [
      t.date,
      TYPE_LABEL[t.type],
      t.type === 'expense' || t.type === 'income' ? (txTitle(t) === TYPE_LABEL[t.type] ? '' : txTitle(t)) : '',
      t.account_name,
      t.bank_name,
      fromPaisa(t.amount),
      t.fee ? fromPaisa(t.fee) : '',
      t.note,
    ]);
  return [header, ...rows].map((r) => r.map(escape).join(',')).join('\n');
}

/** Writes `content` to a temp file and opens the Android share sheet so it can be saved anywhere. */
export async function shareTextFile(filename: string, content: string, mimeType: string) {
  const file = new File(Paths.cache, filename);
  if (file.exists) file.delete();
  file.create();
  file.write(content);
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device.');
  await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: filename });
}
