import { useRouter } from 'expo-router';
import { useMemo, useState, type ReactNode } from 'react';
import { SectionList, StyleSheet, TextInput, View } from 'react-native';

import { TxRow } from '@/components/tx-row';
import { Button, Chip, ChipRow, Empty, ModalHeader, Row, Screen, Txt } from '@/components/ui';
import { Radius, Spacing, withAlpha, type Palette } from '@/constants/theme';
import { listAccounts, listAllTransactions, listCycles, type Tx } from '@/db/queries';
import { useFocusLoad } from '@/hooks/use-focus-load';
import { useStyles, useTheme } from '@/hooks/use-theme';
import { diffDays, shortDate, todayISO, weekdayShort } from '@/lib/dates';
import {
  activeFilterCount,
  applyFilters,
  groupByDate,
  NO_FILTERS,
  summarize,
  type Filters,
  type Period,
  type Sort,
  type TypeFilter,
} from '@/lib/ledger';
import { categoryColor } from '@/lib/labels';
import { formatPKR } from '@/lib/money';

const TYPES: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'expense', label: 'Expenses' },
  { value: 'income', label: 'Income' },
  { value: 'card', label: 'Card' },
];

const SORTS: { value: Sort; label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'largest', label: 'Largest' },
];

/** "Today · 22 Sep", "Yesterday · 21 Sep", "Sat 19 Sep" (with the year when it isn't this year). */
function dayLabel(iso: string): string {
  const diff = diffDays(iso, todayISO());
  if (diff === 0) return `Today · ${shortDate(iso)}`;
  if (diff === 1) return `Yesterday · ${shortDate(iso)}`;
  const year = iso.slice(0, 4) === todayISO().slice(0, 4) ? '' : ` ${iso.slice(0, 4)}`;
  return `${weekdayShort(iso)} ${shortDate(iso)}${year}`;
}

type Section = { key: string; date: string | null; spent: number; data: Tx[] };

export default function AllEntriesScreen() {
  const { colors: c, fonts } = useTheme();
  const styles = useStyles(makeStyles);
  const router = useRouter();

  const { data } = useFocusLoad(async (db) => {
    const [txs, cycles, categories] = await Promise.all([
      listAllTransactions(db),
      listCycles(db),
      listAccounts(db, true),
    ]);
    return { txs, cycles, categories };
  });

  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  const txs = data?.txs;
  const cycles = data?.cycles;

  const ctx = useMemo(
    () => ({ today: todayISO(), currentCycleId: cycles?.[0]?.id ?? null, lastCycleId: cycles?.[1]?.id ?? null }),
    [cycles],
  );
  const rows = useMemo(() => (txs ? applyFilters(txs, filters, ctx) : []), [txs, filters, ctx]);
  const totals = useMemo(() => summarize(rows), [rows]);

  const sections: Section[] = useMemo(() => {
    if (filters.sort === 'largest') return rows.length ? [{ key: 'all', date: null, spent: 0, data: rows }] : [];
    return groupByDate(rows).map((g) => ({ key: g.date, date: g.date, spent: g.spent, data: g.data }));
  }, [rows, filters.sort]);

  if (!data || !txs) return <Screen scroll={false}>{null}</Screen>;

  // Only offer categories and banks that actually appear in the entries.
  const categoryOptions = data.categories.filter((cat) =>
    txs.some((t) => t.type === 'expense' && t.account_id === cat.id),
  );
  const hasUncategorised = txs.some((t) => t.type === 'expense' && t.account_id === null);
  const bankOptions = [
    ...new Map(txs.filter((t) => t.bank_id !== null).map((t) => [t.bank_id!, t.bank_name ?? ''])).entries(),
  ].sort((a, b) => a[1].localeCompare(b[1]));
  const hasNoBank = txs.some((t) => t.bank_id === null);

  const periods: { value: Period; label: string }[] = [
    { value: 'all', label: 'All time' },
    { value: 'cycle', label: 'This cycle' },
    ...(ctx.lastCycleId ? [{ value: 'last' as Period, label: 'Last cycle' }] : []),
    { value: '7d', label: 'Last 7 days' },
    { value: '30d', label: 'Last 30 days' },
  ];

  const count = activeFilterCount(filters);

  const header: ReactNode = (
    <View style={{ gap: Spacing.three, paddingBottom: Spacing.two }}>
      <Row>
        <View style={styles.search}>
          <TextInput
            value={filters.query}
            onChangeText={(v) => set({ query: v })}
            placeholder="Search place, note, bank, amount"
            placeholderTextColor={withAlpha(c.textDim, 0.6)}
            selectionColor={c.text}
            returnKeyType="search"
            autoCorrect={false}
            style={[styles.searchInput, { fontFamily: fonts.regular }]}
          />
          {filters.query ? (
            <Txt variant="dim" style={{ fontWeight: '600' }} onPress={() => set({ query: '' })}>
              Clear
            </Txt>
          ) : null}
        </View>
        <Chip
          label={count > 0 ? `Filters · ${count}` : 'Filters'}
          selected={open || count > 0}
          onPress={() => setOpen((o) => !o)}
        />
      </Row>

      {open ? (
        <View style={styles.panel}>
          <FilterGroup label="Type">
            {TYPES.map((o) => (
              <Chip
                key={o.value}
                label={o.label}
                selected={filters.type === o.value}
                onPress={() => set({ type: o.value })}
              />
            ))}
          </FilterGroup>

          <FilterGroup label="Period">
            {periods.map((o) => (
              <Chip
                key={o.value}
                label={o.label}
                selected={filters.period === o.value}
                onPress={() => set({ period: o.value })}
              />
            ))}
          </FilterGroup>

          <FilterGroup label="Category">
            <Chip label="All" selected={filters.category === 'all'} onPress={() => set({ category: 'all' })} />
            {categoryOptions.map((cat) => (
              <Chip
                key={cat.id}
                label={cat.name}
                dot={categoryColor(cat.name, cat.kind, c)}
                selected={filters.category === cat.id}
                onPress={() => set({ category: cat.id })}
              />
            ))}
            {hasUncategorised ? (
              <Chip
                label="Uncategorised"
                selected={filters.category === 'none'}
                onPress={() => set({ category: 'none' })}
              />
            ) : null}
          </FilterGroup>

          <FilterGroup label="Bank">
            <Chip label="All" selected={filters.bank === 'all'} onPress={() => set({ bank: 'all' })} />
            {bankOptions.map(([id, name]) => (
              <Chip key={id} label={name} selected={filters.bank === id} onPress={() => set({ bank: id })} />
            ))}
            {hasNoBank ? (
              <Chip label="No bank" selected={filters.bank === 'none'} onPress={() => set({ bank: 'none' })} />
            ) : null}
          </FilterGroup>

          <FilterGroup label="Sort">
            {SORTS.map((o) => (
              <Chip
                key={o.value}
                label={o.label}
                selected={filters.sort === o.value}
                onPress={() => set({ sort: o.value })}
              />
            ))}
          </FilterGroup>

          {count > 0 ? (
            <Button
              label="Clear all filters"
              variant="ghost"
              onPress={() => setFilters({ ...NO_FILTERS, sort: filters.sort })}
            />
          ) : null}
        </View>
      ) : null}

      <View style={styles.summary}>
        <Txt variant="small">
          {totals.count} {totals.count === 1 ? 'entry' : 'entries'}
          {count > 0 ? ' match' : ''}
        </Txt>
        <View style={{ flexDirection: 'row', gap: Spacing.three }}>
          {totals.expenses > 0 ? (
            <Txt variant="small" style={{ fontWeight: '600' }} color={c.text}>
              Spent {formatPKR(totals.expenses)}
            </Txt>
          ) : null}
          {totals.income > 0 ? (
            <Txt variant="small" style={{ fontWeight: '600' }} color={c.income}>
              In {formatPKR(totals.income)}
            </Txt>
          ) : null}
        </View>
      </View>
    </View>
  );

  return (
    <Screen scroll={false} style={{ gap: Spacing.three }}>
      <ModalHeader title="All entries" subtitle={count > 0 ? 'Filtered' : `Everything you've recorded`} />
      <SectionList
        sections={sections}
        keyExtractor={(t) => String(t.id)}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={header}
        contentContainerStyle={{ paddingBottom: Spacing.five }}
        renderSectionHeader={({ section }) =>
          section.date ? (
            <View style={styles.dayHeader}>
              <Txt variant="label">{dayLabel(section.date)}</Txt>
              {section.spent > 0 ? <Txt variant="small">-{formatPKR(section.spent)}</Txt> : null}
            </View>
          ) : null
        }
        renderItem={({ item, index, section }) => (
          <TxRow
            tx={item}
            showDate={section.date === null}
            last={index === section.data.length - 1}
            onPress={() => router.push({ pathname: '/add', params: { id: String(item.id) } })}
          />
        )}
        ListEmptyComponent={
          <View style={{ gap: Spacing.three, paddingTop: Spacing.three }}>
            <Empty>{count > 0 ? 'No entries match these filters.' : 'Nothing recorded yet.'}</Empty>
            {count > 0 ? (
              <Button
                label="Clear all filters"
                variant="ghost"
                onPress={() => setFilters({ ...NO_FILTERS, sort: filters.sort })}
              />
            ) : null}
          </View>
        }
      />
    </Screen>
  );
}

function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ gap: Spacing.two }}>
      <Txt variant="label">{label}</Txt>
      <ChipRow>{children}</ChipRow>
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    search: {
      flex: 1,
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
    panel: {
      gap: Spacing.three,
      padding: Spacing.three + 2,
      borderRadius: Radius.lg,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    summary: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: Spacing.two,
    },
    dayHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingTop: Spacing.three,
      paddingBottom: Spacing.one,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
  });
