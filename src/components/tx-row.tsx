import { StyleSheet, View } from 'react-native';

import { Dot, Press, Txt } from '@/components/ui';
import { Spacing, type Palette } from '@/constants/theme';
import type { Tx } from '@/db/queries';
import { useColors, useStyles } from '@/hooks/use-theme';
import { relativeDate } from '@/lib/dates';
import { categoryColor } from '@/lib/labels';
import { formatPKR } from '@/lib/money';

export const TYPE_LABEL: Record<Tx['type'], string> = {
  expense: 'Expense',
  income: 'Income',
  card_payment: 'Card payment',
  card_swipe: 'Card swipe',
  card_withdrawal: 'Card withdrawal',
};

/** Colour and sign for a transaction's amount: only income is coloured, everything else is plain. */
export function txStyle(tx: Tx, c: Palette): { color: string; sign: '+' | '-' | '' } {
  switch (tx.type) {
    case 'income':
      return { color: c.income, sign: '+' };
    case 'expense':
      return { color: c.text, sign: '-' };
    default:
      return { color: c.text, sign: '' };
  }
}

export function txTitle(tx: Tx): string {
  if (tx.type === 'expense') return tx.place || 'Expense';
  if (tx.type === 'income') return tx.source || 'Income';
  return TYPE_LABEL[tx.type];
}

/** "Category · Bank · date" for expenses; the bank alone (with direction) for the other types. */
function txSubtitle(tx: Tx, withDate = true): string {
  const parts: string[] = [];
  if (tx.type === 'expense') {
    parts.push(tx.account_name ?? 'Uncategorised');
    if (tx.bank_name) parts.push(tx.bank_name);
  } else if (tx.type === 'card_payment') {
    parts.push(tx.bank_name ? `from ${tx.bank_name}` : 'bill payment');
  } else if (tx.type === 'card_swipe') {
    parts.push(tx.bank_name ? `to ${tx.bank_name}` : 'to bank');
  } else if (tx.type === 'card_withdrawal') {
    parts.push(tx.bank_name ? `to ${tx.bank_name}` : 'cash');
  } else if (tx.bank_name) {
    parts.push(`to ${tx.bank_name}`);
  }
  if (withDate) parts.push(relativeDate(tx.date));
  return parts.join(' · ');
}

/**
 * `cardView` is the Credit screen: a purchase made with the card reads as "Online" there,
 * wherever it was entered.
 */
export function TxRow({
  tx,
  onPress,
  last,
  cardView,
  showDate = true,
}: {
  tx: Tx;
  onPress?: () => void;
  last?: boolean;
  cardView?: boolean;
  /** Hide the date when the row already sits under a date heading. */
  showDate?: boolean;
}) {
  const c = useColors();
  const styles = useStyles(makeStyles);
  const { color, sign } = txStyle(tx, c);
  const dot =
    tx.type === 'expense' && tx.account_name ? categoryColor(tx.account_name, tx.account_kind ?? 'debit', c) : null;
  const hasFee = (tx.type === 'card_swipe' || tx.type === 'card_withdrawal') && tx.fee > 0;
  const online = cardView && tx.type === 'expense';
  const title = online ? tx.place || 'Online purchase' : txTitle(tx);
  const subtitle = online ? (showDate ? `Online · ${relativeDate(tx.date)}` : 'Online') : txSubtitle(tx, showDate);

  return (
    <Press onPress={onPress} style={[styles.row, !last && styles.divider]}>
      <View style={styles.dotSlot}>{dot ? <Dot color={dot} /> : null}</View>
      <View style={{ flex: 1, gap: 2 }}>
        <Txt numberOfLines={1} style={{ fontWeight: '600' }}>
          {title}
        </Txt>
        <Txt variant="small" numberOfLines={1}>
          {subtitle}
        </Txt>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        <Txt style={{ color, fontWeight: '600' }}>
          {sign}
          {formatPKR(tx.amount)}
        </Txt>
        {hasFee ? (
          <Txt variant="small" color={c.warn}>
            fee {formatPKR(tx.fee)}
          </Txt>
        ) : null}
      </View>
    </Press>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three - 4, paddingVertical: Spacing.three - 2 },
    divider: { borderBottomWidth: 1, borderBottomColor: c.border },
    dotSlot: { width: 10, alignItems: 'center' },
  });
