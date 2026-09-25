import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { Alert, StyleSheet, View } from 'react-native';

import { ArrowDownIcon, ArrowUpIcon, TrashIcon } from '@/components/icons';
import { Avatar, Button, Card, Empty, ModalHeader, Press, Reveal, Screen, SectionTitle, Txt } from '@/components/ui';
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
    Alert.alert(`Delete ${person.name}?`, 'This removes them and their whole history.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deletePerson(db, personId);
          router.back();
        },
      },
    ]);

  const tone = person.balance > 0 ? c.income : person.balance < 0 ? c.danger : c.textDim;

  let i = 0;
  return (
    <Screen>
      <Reveal index={i++}>
        <ModalHeader title={person.name} />
      </Reveal>

      <Reveal index={i++}>
        <Card style={{ gap: 6, paddingVertical: Spacing.four - 4 }}>
          <Txt variant="label">{balanceText(person.balance)}</Txt>
          <Txt variant="hero" color={tone} numberOfLines={1} adjustsFontSizeToFit>
            {formatPKR(Math.abs(person.balance))}
          </Txt>
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
          {entries.length === 0 ? (
            <Empty>No entries yet.</Empty>
          ) : (
            entries.map((e, n) => {
              const moneyIn = DEBT_FLOW[e.kind] === 'in';
              return (
                <View key={e.id} style={[styles.entry, n < entries.length - 1 && styles.divider]}>
                  <Avatar size={36}>
                    {moneyIn ? <ArrowDownIcon color={c.text} size={17} /> : <ArrowUpIcon color={c.text} size={17} />}
                  </Avatar>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Txt style={{ fontWeight: '600' }}>{DEBT_LABEL[e.kind]}</Txt>
                    <Txt variant="small" numberOfLines={1}>
                      {longDate(e.date)}
                      {e.note ? ` · ${e.note}` : ''}
                    </Txt>
                  </View>
                  <Txt style={{ fontWeight: '600' }} color={moneyIn ? c.income : c.text}>
                    {moneyIn ? '+' : '-'}
                    {formatPKR(e.amount)}
                  </Txt>
                  <Press
                    onPress={() => confirmDeleteEntry(e.id)}
                    accessibilityLabel="Delete entry"
                    style={styles.trash}>
                    <TrashIcon color={c.textDim} size={17} />
                  </Press>
                </View>
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
