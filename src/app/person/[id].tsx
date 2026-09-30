import { StackBar } from '@/components/charts';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { ArrowDownIcon, ArrowUpIcon, ChevronIcon, TrashIcon } from '@/components/icons';
import {
  Avatar,
  Button,
  Card,
  Empty,
  ModalHeader,
  Press,
  Reveal,
  Row,
  Screen,
  SectionTitle,
  Txt,
} from '@/components/ui';
import { Radius, Spacing, withAlpha, type Palette } from '@/constants/theme';
import { useColors, useStyles } from '@/hooks/use-theme';
import { deleteDebtEntry, deletePerson, getPerson, listDebtEntries } from '@/db/queries';
import { useFocusLoad } from '@/hooks/use-focus-load';
import { longDate } from '@/lib/dates';
import { balanceText, DEBT_FLOW } from '@/lib/labels';
import { formatPKR } from '@/lib/money';

export default function PersonScreen() {
  const c = useColors();
  const styles = useStyles(makeStyles);
  const db = useSQLiteContext();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const personId = Number(id);
  const [chosen, setChosen] = useState<'they' | 'me' | null>(null);

  const { data, reload } = useFocusLoad(async (d) => {
    const [person, entries] = await Promise.all([getPerson(d, personId), listDebtEntries(d, personId)]);
    return { person, entries };
  });

  if (!data) return <Screen>{null}</Screen>;
  const { person, entries } = data;
  if (!person) {
    return (
      <Screen>
        <ModalHeader title="Not found" />
      </Screen>
    );
  }

  const confirmDeleteEntry = (entryId: number) =>
    Alert.alert('Delete this entry?', 'The balance will be recalculated.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deleteDebtEntry(db, entryId);
          reload();
        },
      },
    ]);

  const confirmDeletePerson = () =>
    Alert.alert(
      `Delete ${person.name}?`,
      entries.some((e) => e.tx_id !== null)
        ? 'This removes them and their whole history. Expenses you paid for them will count fully as your spending again.'
        : 'This removes them and their whole history.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await deletePerson(db, personId);
            router.back();
          },
        },
      ],
    );

  // Show the bigger side first unless a side was picked: what they owe me, or what I owe them.
  const side = chosen ?? (person.i_owe > person.they_owe ? 'me' : 'they');
  const sideKinds = side === 'they' ? ['lent', 'got_back'] : ['borrowed', 'paid_back'];
  const shown = entries.filter((e) => sideKinds.includes(e.kind));
  const tone = person.balance > 0 ? c.income : person.balance < 0 ? c.danger : c.textDim;

  let i = 0;
  return (
    <Screen>
      <Reveal index={i++}>
        <ModalHeader title={person.name} />
      </Reveal>

      <Reveal index={i++}>
        <Card style={{ gap: Spacing.three }}>
          <Row style={{ gap: Spacing.two, alignItems: 'stretch' }}>
            <Press
              onPress={() => setChosen('they')}
              style={[
                styles.side,
                side === 'they' && { borderColor: c.income, backgroundColor: withAlpha(c.income, 0.1) },
              ]}>
              <Txt variant="label">They owe me</Txt>
              <Txt variant="heading" color={c.income} numberOfLines={1} adjustsFontSizeToFit>
                {formatPKR(person.they_owe)}
              </Txt>
            </Press>
            <Press
              onPress={() => setChosen('me')}
              style={[
                styles.side,
                side === 'me' && { borderColor: c.danger, backgroundColor: withAlpha(c.danger, 0.1) },
              ]}>
              <Txt variant="label">I owe them</Txt>
              <Txt variant="heading" color={c.danger} numberOfLines={1} adjustsFontSizeToFit>
                {formatPKR(person.i_owe)}
              </Txt>
            </Press>
          </Row>
          <StackBar
            segments={[
              { value: person.they_owe, color: c.income },
              { value: person.i_owe, color: c.danger },
            ]}
          />
          <Row style={{ justifyContent: 'space-between' }}>
            <Txt variant="dim">{person.balance === 0 ? 'All settled' : `Net: ${balanceText(person.balance)}`}</Txt>
            <Txt style={{ fontWeight: '700' }} color={tone}>
              {formatPKR(Math.abs(person.balance))}
            </Txt>
          </Row>
        </Card>
      </Reveal>

      <Reveal index={i++}>
        <Button
          label="Add entry"
          onPress={() => router.push({ pathname: '/debt-entry', params: { personId: String(personId) } })}
        />
      </Reveal>

      <Reveal index={i++}>
        <SectionTitle>History</SectionTitle>
        <Card style={{ paddingVertical: Spacing.one, marginTop: Spacing.two }}>
          {shown.length === 0 ? (
            <Empty>{side === 'they' ? 'Nothing lent to them yet.' : 'Nothing borrowed from them yet.'}</Empty>
          ) : (
            shown.map((e, n) => {
              const moneyIn = DEBT_FLOW[e.kind] === 'in';
              return (
                <Press
                  key={e.id}
                  onPress={
                    e.tx_id ? () => router.push({ pathname: '/add', params: { id: String(e.tx_id) } }) : undefined
                  }
                  style={[styles.entry, n < shown.length - 1 && styles.divider]}>
                  <Avatar size={36}>
                    {moneyIn ? <ArrowDownIcon color={c.text} size={17} /> : <ArrowUpIcon color={c.text} size={17} />}
                  </Avatar>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Txt numberOfLines={1} style={{ fontWeight: '600' }}>
                      {e.note || 'No details'}
                    </Txt>
                    <Txt variant="small" numberOfLines={1}>
                      {longDate(e.date)}
                    </Txt>
                  </View>
                  <Txt style={{ fontWeight: '600' }} color={moneyIn ? c.income : c.text}>
                    {moneyIn ? '+' : '-'}
                    {formatPKR(e.amount)}
                  </Txt>
                  {e.tx_id ? (
                    <View style={styles.trash}>
                      <ChevronIcon color={c.textDim} size={16} />
                    </View>
                  ) : (
                    <Press
                      onPress={() => confirmDeleteEntry(e.id)}
                      accessibilityLabel="Delete entry"
                      style={styles.trash}>
                      <TrashIcon color={c.textDim} size={17} />
                    </Press>
                  )}
                </Press>
              );
            })
          )}
        </Card>
      </Reveal>

      <Button label="Delete person" variant="danger" onPress={confirmDeletePerson} />
    </Screen>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    entry: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three - 4, paddingVertical: Spacing.three - 4 },
    side: {
      flex: 1,
      gap: 4,
      padding: Spacing.three,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: c.border,
    },
    divider: { borderBottomWidth: 1, borderBottomColor: c.border },
    trash: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  });
