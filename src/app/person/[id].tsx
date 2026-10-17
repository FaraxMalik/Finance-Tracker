import { StackBar } from '@/components/charts';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useState, type ReactNode } from 'react';
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

  const confirmSettle = () => {
    const amount = formatPKR(Math.abs(person.balance));
    Alert.alert(
      `Settle up with ${person.name}?`,
      `${person.balance > 0 ? `${person.name} paid you back ${amount}` : `You paid ${person.name} back ${amount}`}. ` +
        'This is recorded for today, everything so far moves to Settled history, and new entries start from zero.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Settle up',
          onPress: async () => {
            await settleUp(db, personId);
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
  const side = chosen ?? (person.i_owe > person.they_owe ? 'me' : 'they');
  const open = entries.filter((e) => e.settlement_id === null);
  // Paying back more than a side owed moves the extra to the other side (e.g. lent 1,000, got back 1,500: you owe
  // them 500), so that side's list also shows the entries the extra came from.
  const sum = (kinds: string[]) => open.filter((e) => kinds.includes(e.kind)).reduce((n, e) => n + e.amount, 0);
  const theyRaw = sum(['lent']) - sum(['got_back']);
  const meRaw = sum(['borrowed']) - sum(['paid_back']);
  const sideKinds =
    side === 'they'
      ? ['lent', 'got_back', ...(meRaw < 0 ? ['borrowed', 'paid_back'] : [])]
      : ['borrowed', 'paid_back', ...(theyRaw < 0 ? ['lent', 'got_back'] : [])];
  const shown = open.filter((e) => sideKinds.includes(e.kind));
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
        <Row>
          <Button
            label="Add entry"
            style={{ flex: 1 }}
            onPress={() => router.push({ pathname: '/debt-entry', params: { personId: String(personId) } })}
          />
          {person.balance !== 0 ? (
            <Button label="Settle up" variant="ghost" style={{ flex: 1 }} onPress={confirmSettle} />
          ) : null}
        </Row>
      </Reveal>

      <Reveal index={i++}>
        <Row>
          <Chip label="Current" selected={tab === 'current'} onPress={() => setTab('current')} />
          <Chip
            label={settlements.length ? `Settled history (${settlements.length})` : 'Settled history'}
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
                {open.length === 0 && person.settled_on
                  ? `All settled on ${longDate(person.settled_on)}. New entries start here.`
                  : side === 'they'
                    ? 'Nothing lent to them yet.'
                    : 'Nothing borrowed from them yet.'}
              </Empty>
            ) : (
              shown.map((e, n) => entryRow(e, n === shown.length - 1, true))
            )}
          </Card>
        </Reveal>
      ) : settlements.length === 0 ? (
        <Reveal index={i++}>
          <Card>
            <Empty>
              Nothing settled yet. When everything between you adds up to zero, it moves here and a fresh start begins.
            </Empty>
          </Card>
        </Reveal>
      ) : (
        settlements.map((st) => (
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

/** One squared-up stretch: when it ended, what moved each way, and its entries (read-only). */
function SettledGroup({
  settlement: st,
  entries,
  children,
}: {
  settlement: Settlement;
  entries: DebtEntry[];
  children: (list: DebtEntry[]) => ReactNode;
}) {
  const parts = [
    st.lent ? `You lent ${formatPKR(st.lent)}` : null,
    st.got_back ? `got back ${formatPKR(st.got_back)}` : null,
    st.borrowed ? `you borrowed ${formatPKR(st.borrowed)}` : null,
    st.paid_back ? `paid back ${formatPKR(st.paid_back)}` : null,
  ].filter(Boolean);
  return (
    <View style={{ gap: Spacing.two }}>
      <SectionTitle>{`Settled ${longDate(st.settled_on)}`}</SectionTitle>
      <Txt variant="small">
        {parts.join(' · ')} · {st.count} {st.count === 1 ? 'entry' : 'entries'}
      </Txt>
      <Card style={{ paddingVertical: Spacing.one }}>{children(entries)}</Card>
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
