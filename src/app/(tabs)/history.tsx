import { useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { Alert, View } from 'react-native';

import { StackBar } from '@/components/charts';
import { ChevronIcon } from '@/components/icons';
import { Button, Card, Dot, Empty, Header, Press, Reveal, Row, Screen, SectionTitle, Txt } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useColors } from '@/hooks/use-theme';
import { getActiveCycle, getCycleStartDay, getCycleTotals, listClosedCycles, startNewCycle } from '@/db/queries';
import { useFocusLoad } from '@/hooks/use-focus-load';
import { cycleLabel, cycleProgress, nominalEnd } from '@/lib/cycle';
import { success } from '@/lib/haptics';
import { categoryColor } from '@/lib/labels';
import { formatCompact, formatPKR } from '@/lib/money';

export default function HistoryScreen() {
  const c = useColors();
  const db = useSQLiteContext();
  const router = useRouter();

  const { data, reload } = useFocusLoad(async (d) => {
    const cycle = (await getActiveCycle(d))!;
    const startDay = await getCycleStartDay(d);
    const [totals, closed] = await Promise.all([getCycleTotals(d, cycle.id), listClosedCycles(d)]);
    return { cycle, startDay, totals, closed };
  });

  if (!data) return <Screen tabs>{null}</Screen>;
  const { cycle, startDay, totals, closed } = data;
  const progress = cycleProgress(cycle.start_date, startDay);

  const startNew = async () => {
    await startNewCycle(db);
    success();
    await reload();
    router.navigate('/');
  };

  const confirmStartNew = () =>
    Alert.alert(
      'Start a new cycle?',
      'This saves the current cycle as a report and resets your spending and income totals to zero.\n\nYour card balance and debts carry over.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Start new cycle', onPress: startNew },
      ],
    );

  let i = 0;
  return (
    <Screen tabs>
      <Reveal index={i++}>
        <Header eyebrow="History" title="Monthly reports" />
      </Reveal>

      <Reveal index={i++}>
        <Card style={{ gap: Spacing.three }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Txt variant="label">Current cycle</Txt>
            <Txt variant="small">{progress.overdue ? 'Ended' : `${progress.daysLeft} days left`}</Txt>
          </Row>
          <Txt variant="title">{cycleLabel(cycle.start_date, nominalEnd(cycle.start_date, startDay))}</Txt>
          <Row style={{ gap: 0 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Txt variant="small">Spent</Txt>
              <Txt style={{ fontWeight: '600' }}>{formatPKR(totals.totalSpent)}</Txt>
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Txt variant="small">Income</Txt>
              <Txt style={{ fontWeight: '600' }} color={c.income}>
                {formatPKR(totals.income)}
              </Txt>
            </View>
          </Row>
          <Row>
            <Button
              label="View table"
              variant="ghost"
              style={{ flex: 1 }}
              onPress={() => router.push(`/cycle/${cycle.id}`)}
            />
            <Button label="Start new cycle" style={{ flex: 1 }} onPress={confirmStartNew} />
          </Row>
        </Card>
      </Reveal>

      <Reveal index={i++}>
        <Button label="All entries" variant="ghost" onPress={() => router.push('/all')} />
      </Reveal>

      <Reveal index={i++}>
        <SectionTitle>Past cycles</SectionTitle>
      </Reveal>
      {closed.length === 0 ? (
        <Reveal index={i++}>
          <Card>
            <Empty>Closed cycles show up here, each with its full transaction table.</Empty>
          </Card>
        </Reveal>
      ) : (
        closed.map((past) => (
          <Reveal key={past.id} index={i++}>
            <Press onPress={() => router.push(`/cycle/${past.id}`)}>
              <Card>
                <Row>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Txt variant="small">{cycleLabel(past.start_date, past.end_date ?? past.start_date)}</Txt>
                    <Txt variant="title" style={{ fontSize: 24 }}>
                      {formatPKR(past.totalSpent)}
                    </Txt>
                  </View>
                  <ChevronIcon color={c.textDim} size={18} />
                </Row>
                <StackBar
                  segments={past.breakdown.map((b) => ({ value: b.total, color: categoryColor(b.name, b.kind, c) }))}
                />
                <Row style={{ gap: Spacing.two, alignItems: 'flex-start' }}>
                  {past.breakdown.slice(0, 3).map((b) => (
                    <View key={b.id ?? 'none'} style={{ flex: 1, gap: 2 }}>
                      <Row style={{ gap: 6 }}>
                        <Dot color={categoryColor(b.name, b.kind, c)} size={7} />
                        <Txt variant="small" numberOfLines={1} style={{ flex: 1 }}>
                          {b.name}
                        </Txt>
                      </Row>
                      <Txt style={{ fontWeight: '600', fontSize: 14 }}>{`Rs ${formatCompact(b.total)}`}</Txt>
                    </View>
                  ))}
                </Row>
              </Card>
            </Press>
          </Reveal>
        ))
      )}
    </Screen>
  );
}
