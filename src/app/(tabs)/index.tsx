import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { Bars, ProgressBar, type Bar } from '@/components/charts';
import { BankList } from '@/components/bank-list';
import { CategoryList } from '@/components/category-list';
import { CogIcon } from '@/components/icons';
import { TxRow } from '@/components/tx-row';
import {
  Button,
  Card,
  Chip,
  ChipRow,
  Divider,
  Empty,
  Header,
  IconButton,
  Reveal,
  Row,
  Screen,
  SectionTitle,
  Txt,
} from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useColors } from '@/hooks/use-theme';
import {
  getActiveCycle,
  getCycleStartDay,
  getCycleTotals,
  getDailySpend,
  listQuick,
  listTransactions,
} from '@/db/queries';
import { useFocusLoad } from '@/hooks/use-focus-load';
import { cycleLabel, cycleProgress, nominalEnd } from '@/lib/cycle';
import { addDays, diffDays, shortDate, todayISO } from '@/lib/dates';
import { formatPKR } from '@/lib/money';

export default function Dashboard() {
  const c = useColors();
  const router = useRouter();

  const { data } = useFocusLoad(async (db) => {
    const cycle = (await getActiveCycle(db))!;
    const startDay = await getCycleStartDay(db);
    const [totals, daily, recent, quick] = await Promise.all([
      getCycleTotals(db, cycle.id),
      getDailySpend(db, cycle.id),
      listTransactions(db, cycle.id, 5),
      listQuick(db),
    ]);
    return { cycle, startDay, totals, daily, recent, quick };
  });

  if (!data) return <Screen tabs>{null}</Screen>;

  const { cycle, startDay, totals, daily, recent, quick } = data;
  const end = nominalEnd(cycle.start_date, startDay);
  const progress = cycleProgress(cycle.start_date, startDay);
  const today = todayISO();

  const spentByDay = new Map(daily.map((d) => [d.date, d.total]));
  const lastDay = today > end ? today : end;
  const dayCount = diffDays(cycle.start_date, lastDay) + 1;
  const bars: Bar[] = Array.from({ length: dayCount }, (_, i) => {
    const date = addDays(cycle.start_date, i);
    return { key: date, value: spentByDay.get(date) ?? 0, highlight: date === today };
  });
  const labels: [string, string, string] = [
    shortDate(cycle.start_date),
    shortDate(addDays(cycle.start_date, Math.floor(dayCount / 2))),
    shortDate(lastDay),
  ];

  // Whole rupees: paisa-level precision is noise in a daily average.
  const avgPerDay = Math.round(totals.totalSpent / Math.max(progress.dayNumber, 1) / 100) * 100;
  const left = totals.income - totals.totalSpent;

  let i = 0;
  return (
    <Screen tabs>
      <Reveal index={i++}>
        <Header
          eyebrow="This cycle"
          title={cycleLabel(cycle.start_date, end)}
          right={
            <IconButton onPress={() => router.push('/settings')} accessibilityLabel="Settings">
              <CogIcon color={c.text} size={19} />
            </IconButton>
          }
        />
      </Reveal>

      {progress.overdue ? (
        <Reveal index={i++}>
          <Card style={{ borderColor: c.warn }}>
            <Txt style={{ fontWeight: '600' }}>Time for a new cycle</Txt>
            <Txt variant="dim">This cycle ended on {shortDate(end)}. Close it to save the report.</Txt>
            <Button label="Go to History" variant="ghost" onPress={() => router.navigate('/history')} />
          </Card>
        </Reveal>
      ) : null}

      <Reveal index={i++}>
        <View style={{ gap: Spacing.two + 2, paddingVertical: Spacing.two }}>
          <Txt variant="label">Total spent</Txt>
          <Txt variant="hero" numberOfLines={1} adjustsFontSizeToFit>
            {formatPKR(totals.totalSpent)}
          </Txt>
          <Txt variant="dim">
            Credit {formatPKR(totals.creditSpent)} · Debit {formatPKR(totals.debitSpent)}
          </Txt>
          <View style={{ marginTop: Spacing.two, gap: 8 }}>
            <ProgressBar fraction={progress.fraction} />
            <Txt variant="small">
              {progress.overdue
                ? 'Cycle ended'
                : `Day ${progress.dayNumber} of ${progress.totalDays}  ·  ${progress.daysLeft} day${progress.daysLeft === 1 ? '' : 's'} left`}
            </Txt>
          </View>
        </View>
      </Reveal>

      <Reveal index={i++}>
        <SectionTitle>Quick add</SectionTitle>
        <View style={{ marginTop: Spacing.two }}>
          <ChipRow>
            {quick.map((q) => (
              <Chip
                key={q.id}
                label={q.name}
                selected={false}
                onPress={() => router.push({ pathname: '/quick', params: { id: String(q.id) } })}
              />
            ))}
            <Chip label="+ New" selected={false} onPress={() => router.push('/quick-edit')} />
          </ChipRow>
        </View>
      </Reveal>

      <Reveal index={i++}>
        <SectionTitle>By category</SectionTitle>
        <Card style={{ marginTop: Spacing.two }}>
          <CategoryList breakdown={totals.breakdown} total={totals.totalSpent} />
        </Card>
      </Reveal>

      {totals.banks.length > 0 ? (
        <Reveal index={i++}>
          <SectionTitle>By bank</SectionTitle>
          <Card style={{ marginTop: Spacing.two }}>
            <BankList banks={totals.banks} />
          </Card>
        </Reveal>
      ) : null}

      <Reveal index={i++}>
        <Card style={{ flexDirection: 'row', gap: 0, paddingVertical: Spacing.three }}>
          <View style={{ flex: 1, gap: 4 }}>
            <Txt variant="label">Income</Txt>
            <Txt variant="heading" color={c.income} numberOfLines={1} adjustsFontSizeToFit>
              {formatPKR(totals.income)}
            </Txt>
          </View>
          <View style={{ width: 1, backgroundColor: c.border, marginHorizontal: Spacing.three }} />
          <View style={{ flex: 1, gap: 4 }}>
            <Txt variant="label">Left over</Txt>
            <Txt variant="heading" color={left < 0 ? c.danger : c.text} numberOfLines={1} adjustsFontSizeToFit>
              {formatPKR(left, { sign: true })}
            </Txt>
          </View>
        </Card>
      </Reveal>

      <Reveal index={i++}>
        <SectionTitle>Daily spending</SectionTitle>
        <Card style={{ marginTop: Spacing.two }}>
          {daily.length === 0 ? (
            <Empty>Nothing spent yet this cycle.</Empty>
          ) : (
            <>
              <Row style={{ justifyContent: 'space-between' }}>
                <Txt variant="dim">Average</Txt>
                <Txt style={{ fontWeight: '600' }}>{formatPKR(avgPerDay)} a day</Txt>
              </Row>
              <Divider />
              <View style={{ paddingTop: Spacing.one }}>
                <Bars bars={bars} labels={labels} />
              </View>
            </>
          )}
        </Card>
      </Reveal>

      <Reveal index={i++}>
        <SectionTitle
          right={
            <Txt variant="dim" style={{ fontWeight: '600' }} onPress={() => router.push('/all')}>
              See all
            </Txt>
          }>
          Recent
        </SectionTitle>
        <Card style={{ paddingVertical: Spacing.one, marginTop: Spacing.two }}>
          {recent.length === 0 ? (
            <Empty>Tap + to add your first entry. Only the amount is required.</Empty>
          ) : (
            recent.map((tx, n) => (
              <TxRow
                key={tx.id}
                tx={tx}
                last={n === recent.length - 1}
                onPress={() => router.push({ pathname: '/add', params: { id: String(tx.id) } })}
              />
            ))
          )}
        </Card>
      </Reveal>
    </Screen>
  );
}
