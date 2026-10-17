import { StackBar } from '@/components/charts';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useState, type ReactNode } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { ArrowDownIcon, ArrowUpIcon, CheckIcon, ChevronIcon, TrashIcon } from '@/components/icons';
import { Avatar, Button, Card, Chip, Empty, ModalHeader, Press, Reveal, Row, Screen, Txt } from '@/components/ui';
import { Radius, Spacing, withAlpha, type Palette } from '@/constants/theme';
import { useColors, useStyles } from '@/hooks/use-theme';
import {
  deleteDebtEntry,
  deletePerson,
  getPerson,
  listDebtEntries,
  listSettlements,
  settleUp,
  type DebtEntry,
  type DebtSide,
  type Settlement,
} from '@/db/queries';
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
  /** What is still open with them, or the stretches that already ended square. */
  const [tab, setTab] = useState<'current' | 'settled'>('current');

  const { data, reload } = useFocusLoad(async (d) => {
    const [person, entries, settlements] = await Promise.all([
      getPerson(d, personId),
      listDebtEntries(d, personId),
      listSettlements(d, personId),
    ]);
    return { person, entries, settlements };
  });

  if (!data) return <Screen>{null}</Screen>;
  const { person, entries, settlements } = data;
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

  /**
   * Settles only one side: what they owe you, or what you owe them. The other side, if there is one, is left
   * exactly as it was — you can owe a friend for one thing while they still owe you for another.
   */
  const confirmSettle = (settleSide: DebtSide) => {
    const amount = formatPKR(settleSide === 'they' ? person.they_owe : person.i_owe);
    const verb =
      settleSide === 'they' ? `${person.name} paid you back ${amount}` : `You paid ${person.name} back ${amount}`;
    Alert.alert(
      `Settle up with ${person.name}?`,
      `${verb}. This moves it to Settled history, and new entries start from zero.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Settle up',
          onPress: async () => {
            await settleUp(db, personId, settleSide);
            setChosen(settleSide);
            setTab('settled');
            reload();
          },
        },
      ],
    );
  };

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
  const side: DebtSide = chosen ?? (person.i_owe > person.they_owe ? 'me' : 'they');
  const open = entries.filter((e) => e.settlement_id === null);
  const sideKinds = side === 'they' ? ['lent', 'got_back'] : ['borrowed', 'paid_back'];
  const shown = open.filter((e) => sideKinds.includes(e.kind));
  const sideSettledOn = side === 'they' ? person.they_settled_on : person.i_settled_on;
  // Settled history is scoped to whichever side is picked above, same as Current.
  const sideSettlements = settlements.filter((st) => st.side === side);
  const tone = person.balance > 0 ? c.income : person.balance < 0 ? c.danger : c.textDim;

  const entryRow = (e: DebtEntry, last: boolean, canDelete: boolean) => {
    const moneyIn = DEBT_FLOW[e.kind] === 'in';
    return (
      <Press
        key={e.id}
        onPress={e.tx_id ? () => router.push({ pathname: '/add', params: { id: String(e.tx_id) } }) : undefined}
        style={[styles.entry, !last && styles.divider]}>
        <Avatar size={36}>
          {moneyIn ? <ArrowDownIcon color={c.text} size={17} /> : <ArrowUpIcon color={c.text} size={17} />}
        </Avatar>
        <View style={{ flex: 1, gap: 2 }}>
          <Txt numberOfLines={1} style={{ fontWeight: '600' }}>
            {e.note || DEBT_LABEL[e.kind]}
          </Txt>
          <Txt variant="small" numberOfLines={1}>
            {e.note ? `${DEBT_LABEL[e.kind]} · ${longDate(e.date)}` : longDate(e.date)}
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
        ) : canDelete ? (
          <Press onPress={() => confirmDeleteEntry(e.id)} accessibilityLabel="Delete entry" style={styles.trash}>
            <TrashIcon color={c.textDim} size={17} />
          </Press>
        ) : (
          <View style={styles.trash} />
        )}
      </Press>
    );
  };

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
        <View style={{ gap: Spacing.two }}>
          <Button
            label="Add entry"
            onPress={() => router.push({ pathname: '/debt-entry', params: { personId: String(personId) } })}
          />
          {person.they_owe > 0 || person.i_owe > 0 ? (
            <Row>
              {person.they_owe > 0 ? (
                <Button
                  label={`Collect ${formatPKR(person.they_owe)}`}
                  variant="ghost"
                  style={{ flex: 1 }}
                  onPress={() => confirmSettle('they')}
                />
              ) : null}
              {person.i_owe > 0 ? (
                <Button
                  label={`Pay ${formatPKR(person.i_owe)}`}
                  variant="ghost"
                  style={{ flex: 1 }}
                  onPress={() => confirmSettle('me')}
                />
              ) : null}
            </Row>
          ) : null}
        </View>
      </Reveal>

      <Reveal index={i++}>
        <Row>
          <Chip label="Current" selected={tab === 'current'} onPress={() => setTab('current')} />
          <Chip
            label={sideSettlements.length ? `Settled history (${sideSettlements.length})` : 'Settled history'}
            selected={tab === 'settled'}
            onPress={() => setTab('settled')}
          />
        </Row>
      </Reveal>

      {tab === 'current' ? (
        <Reveal index={i++}>
          <Card style={{ paddingVertical: Spacing.one }}>
            {shown.length === 0 ? (
              <Empty>
                {sideSettledOn
                  ? `Settled on ${longDate(sideSettledOn)}. New entries start here.`
                  : side === 'they'
                    ? 'Nothing lent to them yet.'
                    : 'Nothing borrowed from them yet.'}
              </Empty>
            ) : (
              shown.map((e, n) => entryRow(e, n === shown.length - 1, true))
            )}
          </Card>
        </Reveal>
      ) : sideSettlements.length === 0 ? (
        <Reveal index={i++}>
          <Card>
            <Empty>
              {side === 'they'
                ? 'Nothing settled yet. Once what they owe you comes back to zero, it moves here and a fresh start begins.'
                : 'Nothing settled yet. Once what you owe them comes back to zero, it moves here and a fresh start begins.'}
            </Empty>
          </Card>
        </Reveal>
      ) : (
        sideSettlements.map((st) => (
          <Reveal key={st.id} index={i++}>
            <SettledGroup settlement={st} entries={entries.filter((e) => e.settlement_id === st.id)}>
              {(list) => list.map((e, n) => entryRow(e, n === list.length - 1, false))}
            </SettledGroup>
          </Reveal>
        ))
      )}

      <Button label="Delete person" variant="danger" onPress={confirmDeletePerson} />
    </Screen>
  );
}

/** One squared-up stretch for one side: when it ended, what moved, and its entries (read-only, dimmed). */
function SettledGroup({
  settlement: st,
  entries,
  children,
}: {
  settlement: Settlement;
  entries: DebtEntry[];
  children: (list: DebtEntry[]) => ReactNode;
}) {
  const c = useColors();
  const tint = st.side === 'they' ? c.income : c.danger;
  const summary =
    st.side === 'they'
      ? `You lent ${formatPKR(st.lent)} · got back ${formatPKR(st.got_back)}`
      : `You borrowed ${formatPKR(st.borrowed)} · paid back ${formatPKR(st.paid_back)}`;
  return (
    <View style={{ gap: Spacing.two }}>
      <Row style={{ gap: 7 }}>
        <View
          style={{
            width: 18,
            height: 18,
            borderRadius: 9,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: withAlpha(tint, 0.15),
          }}>
          <CheckIcon color={tint} size={11} strokeWidth={2.75} />
        </View>
        <Txt variant="small" style={{ fontWeight: '700' }}>{`Settled ${longDate(st.settled_on)}`}</Txt>
      </Row>
      <Txt variant="small">
        {summary} · {st.count} {st.count === 1 ? 'entry' : 'entries'}
      </Txt>
      <Card style={{ paddingVertical: Spacing.one, backgroundColor: c.bg }}>{children(entries)}</Card>
    </View>
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
