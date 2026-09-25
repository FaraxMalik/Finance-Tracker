import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { DateChips } from '@/components/date-chips';
import { Button, ModalHeader, Screen, Txt } from '@/components/ui';
import { Radius, Spacing, withAlpha, type Palette } from '@/constants/theme';
import { addTransaction, getActiveCycle, getQuick, type QuickExpense } from '@/db/queries';
import { useStyles, useTheme } from '@/hooks/use-theme';
import { todayISO } from '@/lib/dates';
import { success } from '@/lib/haptics';
import { toPaisa } from '@/lib/money';

/**
 * Quick add: pick a saved shortcut (Food, Fuel, ...), type the amount, save.
 * The date is today unless you choose another one.
 */
export default function QuickScreen() {
  const { colors: c, fonts } = useTheme();
  const styles = useStyles(makeStyles);
  const db = useSQLiteContext();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [quick, setQuick] = useState<QuickExpense | null>(null);
  const [cycleId, setCycleId] = useState<number | null>(null);
  const [amount, setAmount] = useState('');
  // null = "use today": resolved when saving, so it is always the real current date.
  const [date, setDate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Reload when coming back from editing; close if this quick add was removed meanwhile.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      (async () => {
        const [found, cycle] = await Promise.all([getQuick(db, Number(id)), getActiveCycle(db)]);
        if (!alive) return;
        if (!found || found.archived) return router.back();
        setQuick(found);
        setCycleId(cycle?.id ?? null);
      })();
      return () => {
        alive = false;
      };
    }, [db, id, router]),
  );

  const save = async () => {
    if (!quick || !cycleId) return;
    const paisa = toPaisa(amount);
    if (paisa <= 0) return setError('Enter an amount greater than zero.');

    setSaving(true);
    await addTransaction(db, cycleId, {
      type: 'expense',
      amount: paisa,
      date: date ?? todayISO(),
      account_id: quick.account_id,
      // A credit-card expense has no bank.
      bank_id: quick.account_kind === 'credit' ? null : quick.bank_id,
      place: quick.name,
    });
    success();
    router.back();
  };

  if (!quick) return <Screen>{null}</Screen>;

  const where = [quick.account_name ?? 'Uncategorised', quick.account_kind === 'credit' ? null : quick.bank_name]
    .filter(Boolean)
    .join(' · ');

  return (
    <Screen
      style={{ gap: Spacing.four }}
      footer={<Button label={`Save ${quick.name.toLowerCase()}`} onPress={save} disabled={saving} />}>
      <ModalHeader title={quick.name} subtitle={`Quick add · ${where}`} onSave={save} saveDisabled={saving} />

      <View style={{ gap: 6 }}>
        <Txt variant="label">Amount</Txt>
        <View style={[styles.amountRow, error ? { borderBottomColor: c.danger } : null]}>
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
            returnKeyType="done"
            onSubmitEditing={save}
            autoFocus
            selectionColor={c.text}
            style={[
              styles.amountInput,
              {
                fontFamily: fonts.display,
                fontSize: Math.round(44 * fonts.scale),
                letterSpacing: fonts.displaySpacing,
              },
            ]}
          />
        </View>
        {error ? (
          <Txt variant="dim" color={c.danger}>
            {error}
          </Txt>
        ) : null}
      </View>

      <DateChips value={date} onChange={setDate} />

      <Txt variant="small" onPress={() => router.push({ pathname: '/quick-edit', params: { id: String(quick.id) } })}>
        Change what this quick add uses ›
      </Txt>
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
    amountInput: {
      flex: 1,
      minWidth: 0,
      color: c.text,
      paddingVertical: 4,
      borderRadius: Radius.sm,
    },
  });
