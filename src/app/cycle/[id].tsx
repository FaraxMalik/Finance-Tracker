import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, StyleSheet, TextInput, View } from 'react-native';

import { BankList } from '@/components/bank-list';
import { CategoryList } from '@/components/category-list';
import { ShareIcon } from '@/components/icons';
import { TxRow } from '@/components/tx-row';
import {
  Button,
  Card,
  Chip,
  ChipRow,
  Divider,
  Empty,
  ModalHeader,
  Reveal,
  Row,
  Screen,
  SectionTitle,
  Txt,
} from '@/components/ui';
import { Radius, Spacing, withAlpha, type Palette } from '@/constants/theme';
import { useStyles, useTheme } from '@/hooks/use-theme';
import {
  getCycle,
  getCycleStartDay,
  getCycleTotals,
  listDebtEntriesForCycle,
  listTransactions,
  type CycleDebtEntry,
} from '@/db/queries';
import { useFocusLoad } from '@/hooks/use-focus-load';
import { cycleLabel, nominalEnd } from '@/lib/cycle';
import { dayLabel, longDate } from '@/lib/dates';
import { shareTextFile, transactionsToCsv } from '@/lib/export';
import { applyFilters, groupByDate, NO_FILTERS, summarize, summarizeDebts, type TypeFilter } from '@/lib/ledger';
import { fromPaisa, formatPKR } from '@/lib/money';

type View_ = TypeFilter | 'debts';

const VIEWS: { value: View_; label: string }[] = [
  { value: 'all', label: 'Everything' },
  { value: 'expense', label: 'Expenses' },
  { value: 'income', label: 'Income' },
  { value: 'card', label: 'Card' },
  { value: 'debts', label: 'Debts' },
];

const DEBT_WORD = { lent: 'Gave', got_back: 'Got back', borrowed: 'Borrowed', paid_back: 'Repaid' } as const;

const matchesDebt = (d: CycleDebtEntry, query: string) => {
  const q = query.trim().toLowerCase().replace(/,/g, '');
  if (!q) return true;
  const hay = [d.person_name, d.note, DEBT_WORD[d.kind], fromPaisa(d.amount)].filter(Boolean).join(' ').toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
};

/** One past (or the current) cycle as a searchable list: totals, debts, and every single entry. */
export default function CycleReport() {
  const { colors: c, fonts } = useTheme();
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const cycleId = Number(id);

  const [query, setQuery] = useState('');
  const [view, setView] = useState<View_>('all');
  const [categories, setCategories] = useState<number[]>([]);

  const { data } = useFocusLoad(async (db) => {
    const cycle = await getCycle(db, cycleId);
    if (!cycle) return null;
    const startDay = await getCycleStartDay(db);
    const [totals, txs, debts] = await Promise.all([
      getCycleTotals(db, cycleId),
      listTransactions(db, cycleId),
      listDebtEntriesForCycle(db, cycle),
    ]);
    return { cycle, startDay, totals, txs, debts };
  });

  const cycle = data?.cycle;
  const txs = data?.txs;
  const debts = data?.debts;

  const rows = useMemo(() => {
    if (!txs || view === 'debts') return [];
    const type: TypeFilter = view;
    return applyFilters(
      txs,
      { ...NO_FILTERS, type, query, categories },
      { today: '', currentCycleId: null, lastCycleId: null },
    );
  }, [txs, view, query, categories]);
  const debtRows = useMemo(
    () => (debts && (view === 'all' || view === 'debts') ? debts.filter((d) => matchesDebt(d, query)) : []),
    [debts, view, query],
  );
  const days = useMemo(() => groupByDate(rows), [rows]);

  if (data === null) return <Screen>{null}</Screen>;
  if (!data || !cycle || !txs || !debts)
    return (
      <Screen>
        <ModalHeader title="Cycle" />
      </Screen>
    );

  const { startDay, totals } = data;
  const isActive = cycle.closed_at === null;
  const end = cycle.end_date ?? nominalEnd(cycle.start_date, startDay);
  const label = cycleLabel(cycle.start_date, end);
  const sum = summarize(txs);
  const debtSum = summarizeDebts(debts);
  const shown = summarize(rows);
  const filtering = query.trim() !== '' || categories.length > 0 || view !== 'all';
  const usedCategories = [
    ...new Map(
      txs.filter((t) => t.type === 'expense').map((t) => [t.account_id ?? 0, t.account_name ?? 'Uncategorised']),
    ).entries(),
  ];

  const exportCsv = async () => {
    try {
      await shareTextFile(`finance-${cycle.start_date}.csv`, transactionsToCsv(txs), 'text/csv');
    } catch (e) {
      Alert.alert('Could not export', e instanceof Error ? e.message : 'Something went wrong.');
    }
  };

  const toggleCategory = (cid: number) =>
    setCategories((list) => (list.includes(cid) ? list.filter((x) => x !== cid) : [...list, cid]));

  return (
    <Screen>
      <ModalHeader
        title={isActive ? 'This cycle' : 'Cycle report'}
        subtitle={`${label}${isActive ? ' · in progress' : ''}`}
      />

      <Reveal index={0}>
        <Card style={{ gap: Spacing.three }}>
          <Row style={{ gap: 0, alignItems: 'flex-start' }}>
            <View style={{ flex: 1, gap: 4 }}>
              <Txt variant="label">Total paid</Txt>
              <Txt variant="heading" numberOfLines={1} adjustsFontSizeToFit>
                {formatPKR(sum.paid)}
              </Txt>
            </View>
            <View style={styles.vline} />
            <View style={{ flex: 1, gap: 4 }}>
              <Txt variant="label">My spending</Txt>
              <Txt variant="heading" numberOfLines={1} adjustsFontSizeToFit>
                {formatPKR(totals.totalSpent)}
              </Txt>
            </View>
          </Row>
          <Divider />
          <Row style={{ justifyContent: 'space-between' }}>
            <Txt variant="dim">Income</Txt>
            <Txt style={{ fontWeight: '600' }} color={c.income}>
              {formatPKR(totals.income)}
            </Txt>
          </Row>
          <Row style={{ justifyContent: 'space-between' }}>
            <Txt variant="dim">Left after spending</Txt>
            <Txt style={{ fontWeight: '600' }} color={totals.income - totals.totalSpent < 0 ? c.danger : c.text}>
              {formatPKR(totals.income - totals.totalSpent, { sign: true })}
            </Txt>
          </Row>
        </Card>
      </Reveal>

      <Reveal index={1}>
        <SectionTitle>Debts this cycle</SectionTitle>
        <Card style={{ gap: Spacing.three, marginTop: Spacing.two }}>
          <Row style={{ gap: Spacing.three }}>
            <Figure label="Gave" value={debtSum.gave} />
            <Figure label="Got back" value={debtSum.gotBack} color={c.income} />
          </Row>
          <Row style={{ gap: Spacing.three }}>
            <Figure label="Borrowed" value={debtSum.borrowed} />
            <Figure label="Repaid" value={debtSum.paidBack} color={c.income} />
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
      </Reveal>

      <Reveal index={2}>
        <SectionTitle>Where it went</SectionTitle>
        <Card style={{ marginTop: Spacing.two }}>
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

      <SectionTitle>{`All entries · ${txs.length + debts.length}`}</SectionTitle>
      <View style={styles.search}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search place, note, person, bank, amount"
          placeholderTextColor={withAlpha(c.textDim, 0.6)}
          selectionColor={c.text}
          autoCorrect={false}
          style={[styles.searchInput, { fontFamily: fonts.regular }]}
        />
        {query ? (
          <Txt variant="dim" style={{ fontWeight: '600' }} onPress={() => setQuery('')}>
            Clear
          </Txt>
        ) : null}
      </View>
      <ChipRow>
        {VIEWS.map((v) => (
          <Chip key={v.value} label={v.label} selected={view === v.value} onPress={() => setView(v.value)} />
        ))}
      </ChipRow>
      {usedCategories.length > 1 && view !== 'debts' ? (
        <ChipRow>
          {usedCategories.map(([cid, name]) => (
            <Chip key={cid} label={name} selected={categories.includes(cid)} onPress={() => toggleCategory(cid)} />
          ))}
        </ChipRow>
      ) : null}

      {filtering && view !== 'debts' ? (
        <Row style={{ justifyContent: 'space-between' }}>
          <Txt variant="small">
            {shown.count} {shown.count === 1 ? 'entry' : 'entries'} match
          </Txt>
          <Txt variant="small" style={{ fontWeight: '600' }} color={c.text}>
            Paid {formatPKR(shown.paid)}
            {shown.expenses !== shown.paid ? ` · Mine ${formatPKR(shown.expenses)}` : ''}
          </Txt>
        </Row>
      ) : null}

      {days.map((g) => (
        <View key={g.date}>
          <View style={styles.dayHeader}>
            <Txt variant="label">{dayLabel(g.date)}</Txt>
            {g.spent > 0 ? <Txt variant="small">-{formatPKR(g.spent)}</Txt> : null}
          </View>
          {g.data.map((tx, n) => (
            <TxRow
              key={tx.id}
              tx={tx}
              showDate={false}
              last={n === g.data.length - 1}
              onPress={isActive ? () => router.push({ pathname: '/add', params: { id: String(tx.id) } }) : undefined}
            />
          ))}
        </View>
      ))}

      {debtRows.length > 0 ? (
        <View>
          <View style={styles.dayHeader}>
            <Txt variant="label">Debts</Txt>
          </View>
          {debtRows.map((d, n) => (
            <Row key={d.id} style={[styles.debtRow, n < debtRows.length - 1 && styles.rowLine]}>
              <View style={{ flex: 1, gap: 2 }}>
                <Txt numberOfLines={1} style={{ fontWeight: '600' }}>
                  {d.person_name}
                </Txt>
                <Txt variant="small" numberOfLines={1}>
                  {DEBT_WORD[d.kind]}
                  {d.note ? ` · ${d.note}` : ''} · {longDate(d.date)}
                </Txt>
              </View>
              <Txt
                style={{ fontWeight: '600' }}
                color={d.kind === 'got_back' || d.kind === 'paid_back' ? c.income : c.text}>
                {formatPKR(d.amount)}
              </Txt>
            </Row>
          ))}
        </View>
      ) : null}

      {rows.length === 0 && debtRows.length === 0 ? (
        <Empty>{filtering ? 'Nothing matches.' : 'No entries in this cycle.'}</Empty>
      ) : null}

      <Button label="Export as CSV" variant="ghost" onPress={exportCsv} icon={<ShareIcon color={c.text} size={18} />} />
    </Screen>
  );
}

function Figure({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Txt variant="small">{label}</Txt>
      <Txt style={{ fontWeight: '700' }} color={color} numberOfLines={1} adjustsFontSizeToFit>
        {formatPKR(value)}
      </Txt>
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    vline: { width: 1, alignSelf: 'stretch', backgroundColor: c.border, marginHorizontal: Spacing.three },
    search: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Spacing.two,
      minHeight: 44,
      paddingHorizontal: Spacing.three,
      borderRadius: Radius.pill,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    searchInput: { flex: 1, minWidth: 0, color: c.text, fontSize: 14, paddingVertical: 8 },
    dayHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingTop: Spacing.three,
      paddingBottom: Spacing.one,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    debtRow: { paddingVertical: Spacing.three - 4, gap: Spacing.three - 4 },
    rowLine: { borderBottomWidth: 1, borderBottomColor: c.border },
  });
