import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { ArrowDownIcon, ArrowUpIcon, ChevronIcon, TrashIcon } from '@/components/icons';
import {
  Avatar,
  Button,
  Card,
  Chip,
  Empty,
  ModalHeader,
  Press,
  Reveal,
  Row,
  Screen,
  SectionTitle,
  Txt,
} from '@/components/ui';
import { Spacing, type Palette } from '@/constants/theme';
import { useColors, useStyles } from '@/hooks/use-theme';
import { deleteDebtEntry, deletePerson, getPerson, listDebtEntries } from '@/db/queries';
import { useFocusLoad } from '@/hooks/use-focus-load';
import { longDate } from '@/lib/dates';
import { balanceText, DEBT_FLOW, DEBT_LABEL } from '@/lib/labels';
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
  const sideAmount = side === 'they' ? person.they_owe : person.i_owe;
  const tone = sideAmount === 0 ? c.textDim : side === 'they' ? c.income : c.danger;

  let i = 0;
  return (
    <Screen>
      <Reveal index={i++}>
        <ModalHeader title={person.name} />
      </Reveal>

      <Reveal index={i++}>
        <Card style={{ gap: 6, paddingVertical: Spacing.four - 4 }}>
          <Txt variant="label">{side === 'they' ? 'They owe me' : 'I owe them'}</Txt>
          <Txt variant="hero" color={tone} numberOfLines={1} adjustsFontSizeToFit>
            {formatPKR(sideAmount)}
          </Txt>
          <Txt variant="small">
            Overall: {balanceText(person.balance)} {person.balance === 0 ? '' : formatPKR(Math.abs(person.balance))}
          </Txt>
        </Card>
      </Reveal>

      <Reveal index={i++}>
        <Row>
          <Chip label="They owe me" selected={side === 'they'} onPress={() => setChosen('they')} />
          <Chip label="I owe them" selected={side === 'me'} onPress={() => setChosen('me')} />
        </Row>
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
                    <Txt style={{ fontWeight: '600' }}>{e.tx_id ? 'I paid for them' : DEBT_LABEL[e.kind]}</Txt>
                    <Txt variant="small" numberOfLines={1}>
                      {longDate(e.date)}
                      {e.note ? ` · ${e.note}` : ''}
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
    divider: { borderBottomWidth: 1, borderBottomColor: c.border },
    trash: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  });
