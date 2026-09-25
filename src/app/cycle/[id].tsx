import { useLocalSearchParams, useRouter } from 'expo-router';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { BankList } from '@/components/bank-list';
import { CategoryList } from '@/components/category-list';
import { ShareIcon } from '@/components/icons';
import { txStyle, txTitle } from '@/components/tx-row';
import { Button, Card, Divider, Empty, ModalHeader, Reveal, Row, Screen, SectionTitle, Txt } from '@/components/ui';
import { Radius, Spacing, type Palette } from '@/constants/theme';
import { useColors, useStyles } from '@/hooks/use-theme';
import { getCycle, getCycleStartDay, getCycleTotals, listTransactions, type Tx } from '@/db/queries';
import { useFocusLoad } from '@/hooks/use-focus-load';
import { cycleLabel, nominalEnd } from '@/lib/cycle';
import { shortDate } from '@/lib/dates';
import { shareTextFile, transactionsToCsv } from '@/lib/export';
import { formatPKR } from '@/lib/money';

export default function CycleReport() {
  const c = useColors();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const cycleId = Number(id);

  const { data } = useFocusLoad(async (db) => {
    const cycle = await getCycle(db, cycleId);
    if (!cycle) return null;
    const startDay = await getCycleStartDay(db);
    const [totals, txs] = await Promise.all([getCycleTotals(db, cycleId), listTransactions(db, cycleId)]);
    return { cycle, startDay, totals, txs };
  });

  if (data === null) return <Screen>{null}</Screen>;
  if (!data.cycle)
    return (
      <Screen>
        <ModalHeader title="Not found" />
      </Screen>
    );

  const { cycle, startDay, totals, txs } = data;
  const isActive = cycle.closed_at === null;
  const end = cycle.end_date ?? nominalEnd(cycle.start_date, startDay);
  const label = cycleLabel(cycle.start_date, end);

  const incoming = txs.filter((t) => t.type === 'income');
  const spending = txs.filter((t) => t.type === 'expense');
  const card = txs.filter((t) => t.type === 'card_payment' || t.type === 'card_swipe' || t.type === 'card_withdrawal');
  const sum = (list: Tx[]) => list.reduce((s, t) => s + t.amount, 0);

  const exportCsv = async () => {
    try {
      await shareTextFile(`finance-${cycle.start_date}.csv`, transactionsToCsv(txs), 'text/csv');
    } catch (e) {
      Alert.alert('Could not export', e instanceof Error ? e.message : 'Something went wrong.');
    }
  };

  const open = (tx: Tx) => isActive && router.push({ pathname: '/add', params: { id: String(tx.id) } });

  return (
    <Screen>
      <ModalHeader
        title={isActive ? 'This cycle' : 'Cycle report'}
        subtitle={`${label}${isActive ? ' · in progress' : ''}`}
      />

      <Reveal index={0}>
        <View style={{ gap: 6, paddingVertical: Spacing.two }}>
          <Txt variant="label">Total spent</Txt>
          <Txt variant="hero" numberOfLines={1} adjustsFontSizeToFit>
            {formatPKR(totals.totalSpent)}
          </Txt>
        </View>
      </Reveal>

      <Reveal index={1}>
        <Card>
          <CategoryList breakdown={totals.breakdown} total={totals.totalSpent} />
        </Card>
      </Reveal>

      {totals.banks.length > 0 ? (
        <>
          <SectionTitle>By bank</SectionTitle>
          <Card>
            <BankList banks={totals.banks} />
          </Card>
        </>
      ) : null}

      <Card style={{ gap: Spacing.three }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Txt variant="dim">Income</Txt>
          <Txt style={{ fontWeight: '600' }} color={c.income}>
            {formatPKR(totals.income)}
          </Txt>
        </Row>
        <Divider />
        <Row style={{ justifyContent: 'space-between' }}>
          <Txt variant="dim">Left after spending</Txt>
          <Txt style={{ fontWeight: '600' }} color={totals.income - totals.totalSpent < 0 ? c.danger : c.text}>
            {formatPKR(totals.income - totals.totalSpent, { sign: true })}
          </Txt>
        </Row>
        {!isActive && cycle.snap_card_owed !== null ? (
          <>
            <Divider />
            <Row style={{ justifyContent: 'space-between' }}>
              <Txt variant="dim">Card owed at close</Txt>
              <Txt style={{ fontWeight: '600' }}>{formatPKR(cycle.snap_card_owed)}</Txt>
            </Row>
            <Row style={{ justifyContent: 'space-between' }}>
              <Txt variant="dim">Owed to me at close</Txt>
              <Txt style={{ fontWeight: '600' }}>{formatPKR(cycle.snap_owed_to_me ?? 0)}</Txt>
            </Row>
            <Row style={{ justifyContent: 'space-between' }}>
              <Txt variant="dim">I owed at close</Txt>
              <Txt style={{ fontWeight: '600' }}>{formatPKR(cycle.snap_i_owe ?? 0)}</Txt>
            </Row>
          </>
        ) : null}
      </Card>

      <Table title="Incoming" rows={incoming} total={sum(incoming)} onRow={open} empty="No income recorded." />
      <Table title="Spending" rows={spending} total={sum(spending)} onRow={open} empty="No spending recorded." />
      <Table title="Card activity" rows={card} onRow={open} empty="No card payments, swipes or withdrawals." />

      <Button label="Export as CSV" variant="ghost" onPress={exportCsv} icon={<ShareIcon color={c.text} size={18} />} />
    </Screen>
  );
}

function Table({
  title,
  rows,
  total,
  onRow,
  empty,
}: {
  title: string;
  rows: Tx[];
  total?: number;
  onRow: (tx: Tx) => void;
  empty: string;
}) {
  const c = useColors();
  const styles = useStyles(makeStyles);
  return (
    <>
      <SectionTitle
        right={
          total !== undefined && rows.length > 0 ? (
            <Txt variant="dim" style={{ fontWeight: '600' }}>
              {formatPKR(total)}
            </Txt>
          ) : null
        }>
        {title}
      </SectionTitle>
      <View style={styles.table}>
        {rows.length === 0 ? (
          <Empty>{empty}</Empty>
        ) : (
          <>
            <View style={[styles.tr, styles.thead]}>
              <Txt variant="small" style={styles.cDate}>
                Date
              </Txt>
              <Txt variant="small" style={styles.cWhat}>
                Detail
              </Txt>
              <Txt variant="small" style={styles.cAcc}>
                Category / bank
              </Txt>
              <Txt variant="small" style={styles.cAmt}>
                Amount
              </Txt>
            </View>
            {rows.map((tx, i) => {
              const { color, sign } = txStyle(tx, c);
              const detail =
                (tx.type === 'card_swipe' || tx.type === 'card_withdrawal') && tx.fee > 0
                  ? `${tx.type === 'card_swipe' ? 'Swipe' : 'Withdrawal'} · fee ${formatPKR(tx.fee)}`
                  : txTitle(tx);
              return (
                <Pressable
                  key={tx.id}
                  onPress={() => onRow(tx)}
                  style={[styles.tr, i < rows.length - 1 && styles.rowLine]}>
                  <Txt variant="dim" style={styles.cDate}>
                    {shortDate(tx.date)}
                  </Txt>
                  <Txt style={[styles.cWhat, { fontSize: 14 }]} numberOfLines={2}>
                    {detail}
                  </Txt>
                  <View style={styles.cAcc}>
                    <Txt variant="dim" style={{ fontSize: 12 }} numberOfLines={1}>
                      {tx.type === 'expense' ? (tx.account_name ?? 'Uncategorised') : (tx.bank_name ?? '—')}
                    </Txt>
                    {tx.type === 'expense' && tx.bank_name ? (
                      <Txt variant="small" numberOfLines={1}>
                        {tx.bank_name}
                      </Txt>
                    ) : null}
                  </View>
                  <Txt style={[styles.cAmt, { color, fontWeight: '600', fontSize: 13 }]} numberOfLines={1}>
                    {sign}
                    {formatPKR(tx.amount).replace('Rs ', '')}
                  </Txt>
                </Pressable>
              );
            })}
          </>
        )}
      </View>
    </>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    table: {
      backgroundColor: c.surface,
      borderRadius: Radius.lg,
      borderWidth: 1,
      borderColor: c.border,
      overflow: 'hidden',
    },
    tr: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 11,
      paddingHorizontal: Spacing.three - 2,
      gap: 6,
    },
    thead: { backgroundColor: c.bg, borderBottomWidth: 1, borderBottomColor: c.border },
    rowLine: { borderBottomWidth: 1, borderBottomColor: c.border },
    cDate: { width: 54 },
    cWhat: { flex: 1 },
    cAcc: { width: 88 },
    cAmt: { width: 72, textAlign: 'right' },
  });
