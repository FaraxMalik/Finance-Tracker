import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { StackBar } from '@/components/charts';
import { ChevronIcon } from '@/components/icons';
import { Avatar, Card, Chip, Empty, Header, Press, Reveal, Row, Screen, SectionTitle, Txt } from '@/components/ui';
import { Spacing, type Palette } from '@/constants/theme';
import { getActiveCycle, getCycleTotals, getDebtTotals, listPeople } from '@/db/queries';
import { useFocusLoad } from '@/hooks/use-focus-load';
import { useColors, useStyles } from '@/hooks/use-theme';
import { initials } from '@/lib/labels';
import { formatPKR } from '@/lib/money';

export default function DebtsScreen() {
  const c = useColors();
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const [side, setSide] = useState<'they' | 'me'>('they');

  const { data } = useFocusLoad(async (db) => {
    const cycle = await getActiveCycle(db);
    const [totals, people, cycleTotals] = await Promise.all([
      getDebtTotals(db),
      listPeople(db),
      cycle ? getCycleTotals(db, cycle.id) : null,
    ]);
    return { totals, people, paidForFriends: cycleTotals?.sharedOut ?? 0 };
  });

  if (!data) return <Screen tabs>{null}</Screen>;
  const { totals, people, paidForFriends } = data;
  const owed = (p: (typeof people)[number]) => (side === 'they' ? p.they_owe : p.i_owe);
  const shown = people.filter((p) => owed(p) > 0).sort((a, b) => owed(b) - owed(a));
  const sideTotal = side === 'they' ? totals.owedToMe : totals.iOwe;

  let i = 0;
  return (
    <Screen tabs>
      <Reveal index={i++}>
        <Header eyebrow="Debts" title="Who owes what" />
      </Reveal>

      <Reveal index={i++}>
        <Card style={{ gap: Spacing.three }}>
          <Row style={{ gap: 0, alignItems: 'flex-start' }}>
            <View style={{ flex: 1, gap: 4 }}>
              <Txt variant="label">Owed to me</Txt>
              <Txt variant="heading" color={c.income} numberOfLines={1} adjustsFontSizeToFit>
                {formatPKR(totals.owedToMe)}
              </Txt>
            </View>
            <View
              style={{ width: 1, alignSelf: 'stretch', backgroundColor: c.border, marginHorizontal: Spacing.three }}
            />
            <View style={{ flex: 1, gap: 4 }}>
              <Txt variant="label">I owe</Txt>
              <Txt variant="heading" color={c.danger} numberOfLines={1} adjustsFontSizeToFit>
                {formatPKR(totals.iOwe)}
              </Txt>
            </View>
          </Row>
          <StackBar
            segments={[
              { value: totals.owedToMe, color: c.income },
              { value: totals.iOwe, color: c.danger },
            ]}
          />
          {paidForFriends > 0 ? (
            <Row style={{ justifyContent: 'space-between' }}>
              <Txt variant="dim">Paid for friends this cycle</Txt>
              <Txt style={{ fontWeight: '600' }}>{formatPKR(paidForFriends)}</Txt>
            </Row>
          ) : null}
          <Row style={{ justifyContent: 'space-between' }}>
            <Txt variant="dim">Net</Txt>
            <Txt style={{ fontWeight: '700' }} color={totals.net < 0 ? c.danger : c.text}>
              {formatPKR(totals.net, { sign: true })}
            </Txt>
          </Row>
        </Card>
      </Reveal>

      <Reveal index={i++}>
        <SectionTitle>People</SectionTitle>
        <Row style={{ marginTop: Spacing.two }}>
          <Chip label="They owe me" selected={side === 'they'} onPress={() => setSide('they')} />
          <Chip label="I owe them" selected={side === 'me'} onPress={() => setSide('me')} />
        </Row>
        {shown.length > 0 ? (
          <Row style={{ justifyContent: 'space-between', marginTop: Spacing.two }}>
            <Txt variant="small">
              {shown.length} {shown.length === 1 ? 'person' : 'people'}
            </Txt>
            <Txt style={{ fontWeight: '700' }} color={side === 'they' ? c.income : c.danger}>
              {formatPKR(sideTotal)}
            </Txt>
          </Row>
        ) : null}
        <Card style={{ paddingVertical: Spacing.one, marginTop: Spacing.two }}>
          {people.length === 0 ? (
            <Empty>No one yet. Tap + to record money you lent or borrowed.</Empty>
          ) : shown.length === 0 ? (
            <Empty>{side === 'they' ? 'No one owes you anything.' : 'You owe no one anything.'}</Empty>
          ) : (
            shown.map((p, n) => (
              <Press
                key={p.id}
                onPress={() => router.push(`/person/${p.id}`)}
                style={[styles.person, n < shown.length - 1 && styles.divider]}>
                <Avatar>
                  <Txt style={{ fontWeight: '600', fontSize: 13 }}>{initials(p.name)}</Txt>
                </Avatar>
                <View style={{ flex: 1, gap: 2 }}>
                  <Txt numberOfLines={1} style={{ fontWeight: '600' }}>
                    {p.name}
                  </Txt>
                  <Txt variant="small">{side === 'they' ? 'owes you' : 'you owe'}</Txt>
                </View>
                <Txt style={{ fontWeight: '600' }} color={side === 'they' ? c.income : c.danger}>
                  {formatPKR(owed(p))}
                </Txt>
                <ChevronIcon color={c.textDim} size={16} />
              </Press>
            ))
          )}
        </Card>
      </Reveal>
    </Screen>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    person: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three - 4, paddingVertical: Spacing.three - 4 },
    divider: { borderBottomWidth: 1, borderBottomColor: c.border },
  });
