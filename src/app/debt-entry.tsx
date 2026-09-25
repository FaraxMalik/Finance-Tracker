import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { DateChips } from '@/components/date-chips';
import { Button, Chip, ChipRow, Field, ModalHeader, Screen, Txt } from '@/components/ui';
import { Spacing, withAlpha, type Palette } from '@/constants/theme';
import { useStyles, useTheme } from '@/hooks/use-theme';
import { addDebtEntry, findOrCreatePerson, getPerson, listPeople, type DebtKind, type Person } from '@/db/queries';
import { todayISO } from '@/lib/dates';
import { success } from '@/lib/haptics';
import { DEBT_FLOW, DEBT_LABEL } from '@/lib/labels';
import { toPaisa } from '@/lib/money';

const KINDS: DebtKind[] = ['lent', 'borrowed', 'got_back', 'paid_back'];

export default function DebtEntryScreen() {
  const { colors: c, fonts } = useTheme();
  const styles = useStyles(makeStyles);
  const db = useSQLiteContext();
  const router = useRouter();
  const { personId } = useLocalSearchParams<{ personId?: string }>();

  const [people, setPeople] = useState<Person[]>([]);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<DebtKind>('lent');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      setPeople(await listPeople(db));
      if (personId) {
        const p = await getPerson(db, Number(personId));
        if (p) setName(p.name);
      }
    })();
  }, [db, personId]);

  const save = async () => {
    if (!name.trim()) return setError('Who is this with? Pick a person or type a name.');
    const paisa = toPaisa(amount);
    if (paisa <= 0) return setError('Enter an amount greater than zero.');

    setSaving(true);
    const id = await findOrCreatePerson(db, name);
    await addDebtEntry(db, id, kind, paisa, date, note);
    success();
    router.back();
  };

  const color = DEBT_FLOW[kind] === 'in' ? c.income : c.text;

  return (
    <Screen
      style={{ gap: Spacing.four }}
      footer={
        <View style={{ gap: Spacing.two }}>
          {error ? (
            <Txt variant="dim" color={c.danger}>
              {error}
            </Txt>
          ) : null}
          <Button label="Save entry" onPress={save} disabled={saving} />
        </View>
      }>
      <ModalHeader title="Debt entry" onSave={save} saveDisabled={saving} />

      <View style={{ gap: Spacing.two }}>
        <Txt variant="label">What happened</Txt>
        <ChipRow>
          {KINDS.map((k) => (
            <Chip key={k} label={DEBT_LABEL[k]} selected={kind === k} onPress={() => setKind(k)} />
          ))}
        </ChipRow>
      </View>

      <View style={{ gap: 6 }}>
        <Txt variant="label">Amount</Txt>
        <View style={styles.amountRow}>
          <Txt style={{ fontSize: 20, fontWeight: '500' }} color={c.textDim}>
            Rs
          </Txt>
          <TextInput
            value={amount}
            onChangeText={(v) => {
              setAmount(v);
              setError(null);
            }}
            placeholder="0"
            placeholderTextColor={withAlpha(c.textDim, 0.4)}
            keyboardType="decimal-pad"
            selectionColor={c.text}
            style={[
              styles.amountInput,
              {
                fontFamily: fonts.display,
                fontSize: Math.round(44 * fonts.scale),
                letterSpacing: fonts.displaySpacing,
                color,
              },
            ]}
          />
        </View>
      </View>

      <View style={{ gap: Spacing.two }}>
        {people.length > 0 ? (
          <>
            <Txt variant="label">Person</Txt>
            <ChipRow>
              {people.map((p) => (
                <Chip
                  key={p.id}
                  label={p.name}
                  selected={name.trim().toLowerCase() === p.name.toLowerCase()}
                  onPress={() => {
                    setName(p.name);
                    setError(null);
                  }}
                />
              ))}
            </ChipRow>
          </>
        ) : null}
        <Field
          label={people.length > 0 ? 'Or a new name' : 'Person'}
          value={name}
          onChangeText={(v) => {
            setName(v);
            setError(null);
          }}
          placeholder="e.g. Ali"
        />
      </View>

      <DateChips value={date} onChange={(d) => setDate(d ?? todayISO())} />

      <Field label="Note" optional value={note} onChangeText={setNote} placeholder="What was it for?" multiline />
    </Screen>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    amountRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      paddingBottom: 4,
    },
    amountInput: { flex: 1, minWidth: 0, fontSize: 44, letterSpacing: -1, paddingVertical: 4 },
  });
