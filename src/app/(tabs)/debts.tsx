import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { StackBar } from '@/components/charts';
import { ChevronIcon } from '@/components/icons';
import { Avatar, Card, Empty, Header, Press, Reveal, Row, Screen, SectionTitle, Txt } from '@/components/ui';
import { Spacing, type Palette } from '@/constants/theme';
import { getDebtTotals, listPeople } from '@/db/queries';
import { useFocusLoad } from '@/hooks/use-focus-load';
import { useColors, useStyles } from '@/hooks/use-theme';
import { balanceText, initials } from '@/lib/labels';
import { formatPKR } from '@/lib/money';

export default function DebtsScreen() {
  const c = useColors();
  const styles = useStyles(makeStyles);
  const router = useRouter();

  const { data } = useFocusLoad(async (db) => {
    const [totals, people] = await Promise.all([getDebtTotals(db), listPeople(db)]);
    return { totals, people };
  });

  if (!data) return <Screen tabs>{null}</Screen>;
  const { totals, people } = data;

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
        <Card style={{ paddingVertical: Spacing.one, marginTop: Spacing.two }}>
          {people.length === 0 ? (
            <Empty>No one yet. Tap + to record money you lent or borrowed.</Empty>
          ) : (
            people.map((p, n) => (
              <Press
                key={p.id}
                onPress={() => router.push(`/person/${p.id}`)}
                style={[styles.person, n < people.length - 1 && styles.divider]}>
                <Avatar>
                  <Txt style={{ fontWeight: '600', fontSize: 13 }}>{initials(p.name)}</Txt>
                </Avatar>
                <View style={{ flex: 1, gap: 2 }}>
                  <Txt numberOfLines={1} style={{ fontWeight: '600' }}>
                    {p.name}
                  </Txt>
                  <Txt variant="small">{balanceText(p.balance)}</Txt>
                </View>
                <Txt
                  style={{ fontWeight: '600' }}
                  color={p.balance > 0 ? c.income : p.balance < 0 ? c.danger : c.textDim}>
                  {formatPKR(Math.abs(p.balance))}
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
