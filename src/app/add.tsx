import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { Alert, StyleSheet, TextInput, View } from 'react-native';

import { DateChips } from '@/components/date-chips';
import { Button, Card, Chip, ChipRow, Field, ModalHeader, Press, Screen, Txt } from '@/components/ui';
import { Radius, Spacing, withAlpha, type Palette } from '@/constants/theme';
import {
  addTransaction,
  deleteTransaction,
  getActiveCycle,
  getNumberSetting,
  getTransaction,
  listAccounts,
  listBanks,
  listQuick,
  setSetting,
  updateTransaction,
  type Account,
  type Bank,
  type QuickExpense,
  type TxType,
} from '@/db/queries';
import { useStyles, useTheme } from '@/hooks/use-theme';
import { todayISO } from '@/lib/dates';
import { success } from '@/lib/haptics';
import { categoryColor } from '@/lib/labels';
import { formatPKR, fromPaisa, toPaisa } from '@/lib/money';

type TypeOption = { type: TxType; label: string; save: string };

/** Home's + adds an expense or income. */
const DAILY_TYPES: TypeOption[] = [
  { type: 'expense', label: 'Expense', save: 'Save expense' },
  { type: 'income', label: 'Income', save: 'Save income' },
];

/**
 * The Credit screen's + adds only these. "Online" is a purchase made with the card: an expense filed under
 * the Credit Card category, so it also shows up in Home's totals and needs no bank.
 */
const CARD_TYPES: TypeOption[] = [
  { type: 'expense', label: 'Online', save: 'Save online purchase' },
  { type: 'card_swipe', label: 'Swipe', save: 'Save swipe' },
  { type: 'card_withdrawal', label: 'Withdrawal', save: 'Save withdrawal' },
  { type: 'card_payment', label: 'Payment', save: 'Save payment' },
];

/** Entry types that only exist on the card (an "expense" can be either kind, so it is not listed). */
const isCardOnlyType = (t?: string): boolean => t === 'card_swipe' || t === 'card_withdrawal' || t === 'card_payment';

const INCOME_SOURCES = ['Salary', 'Project', 'Other'];

/** Which bank the money left from / arrived in, per entry type. */
const BANK_LABEL: Record<TxType, string> = {
  expense: 'Paid from',
  income: 'Received in',
  card_payment: 'Paid from',
  card_swipe: 'Money received in',
  card_withdrawal: 'Cash received in',
};

const ONLINE_HINT =
  'A purchase made with the card, usually online. It adds to what you owe and counts under Credit Card spending. No bank needed.';

const HINT: Partial<Record<TxType, string>> = {
  card_payment: 'Paying your card bill. This lowers what you owe and is not counted as spending.',
  card_swipe:
    'Swiping the card on the machine to get money in your bank. It adds to what you owe on the card; only the fee counts as spending.',
  card_withdrawal:
    'Withdrawing cash from an ATM with the card. It adds to what you owe on the card; only the fee counts as spending.',
};

export default function AddScreen() {
  const { colors: c, fonts } = useTheme();
  const styles = useStyles(makeStyles);
  const db = useSQLiteContext();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string; type?: string; scope?: string }>();
  const editingId = params.id ? Number(params.id) : null;

  const [cardScope, setCardScope] = useState(params.scope === 'card' || isCardOnlyType(params.type));
  const options = cardScope ? CARD_TYPES : DAILY_TYPES;
  const [type, setType] = useState<TxType>(
    options.some((o) => o.type === params.type) ? (params.type as TxType) : options[0].type,
  );
  const [amount, setAmount] = useState('');
  const [fee, setFee] = useState('');
  const [date, setDate] = useState(todayISO());
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [bankId, setBankId] = useState<number | null>(null);
  const [place, setPlace] = useState('');
  const [source, setSource] = useState('');
  const [note, setNote] = useState('');

  const [categories, setCategories] = useState<Account[]>([]);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [quick, setQuick] = useState<QuickExpense[]>([]);
  const [cycleId, setCycleId] = useState<number | null>(null);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const [cats, bks, cycle] = await Promise.all([listAccounts(db, true), listBanks(db, true), getActiveCycle(db)]);
      setCategories(cats);
      setBanks(bks);
      setQuick(await listQuick(db));
      setCycleId(cycle?.id ?? null);
      const cash = bks.find((b) => b.name.toLowerCase() === 'cash' && !b.archived);

      if (editingId) {
        const tx = await getTransaction(db, editingId);
        if (!tx) return router.back();
        setLocked(tx.cycle_id !== cycle?.id);
        // A purchase on the credit card is edited as "Online", the way the Credit screen shows it.
        setCardScope(isCardOnlyType(tx.type) || (tx.type === 'expense' && tx.account_kind === 'credit'));
        setType(tx.type);
        setAmount(fromPaisa(tx.amount));
        setFee(tx.fee ? fromPaisa(tx.fee) : '');
        setDate(tx.date);
        setCategoryId(tx.account_id);
        setBankId(tx.bank_id);
        setPlace(tx.place ?? '');
        setSource(tx.source ?? '');
        setNote(tx.note ?? '');
      } else if (params.type === 'card_withdrawal') {
        // A withdrawal hands you cash.
        if (cash) setBankId(cash.id);
      } else if (params.scope !== 'card' && (!params.type || params.type === 'expense')) {
        // New expenses start from the last category and bank you used.
        const lastCat = await getNumberSetting(db, 'last_account_id', 0);
        const lastBank = await getNumberSetting(db, 'last_bank_id', 0);
        if (cats.some((x) => x.id === lastCat && !x.archived)) setCategoryId(lastCat);
        if (bks.some((b) => b.id === lastBank && !b.archived)) setBankId(lastBank);
      }
    })();
  }, [db, editingId, router, params.type, params.scope]);

  const selectType = (next: TxType) => {
    if (locked) return;
    setType(next);
    if (next === 'card_withdrawal' && bankId === null) {
      const cash = banks.find((b) => b.name.toLowerCase() === 'cash' && !b.archived);
      if (cash) setBankId(cash.id);
    }
  };

  // "Online" (an expense from the Credit screen) is always the credit card category.
  const cardOnline = cardScope && type === 'expense';
  const creditCategory = categories.find((x) => x.kind === 'credit' && !x.archived) ?? null;

  // Otherwise only expenses have a category. A hidden (removed) one still shows if this entry uses it.
  const categoryChoices =
    type === 'expense' && !cardOnline ? categories.filter((x) => !x.archived || x.id === categoryId) : [];
  const category = cardOnline ? creditCategory : (categoryChoices.find((x) => x.id === categoryId) ?? null);

  // A credit-card expense isn't paid from a bank (the bill is paid later, as a card payment).
  const onCard = type === 'expense' && category?.kind === 'credit';
  const bankChoices = banks.filter((b) => !b.archived || b.id === bankId);
  const bank = onCard ? null : (bankChoices.find((b) => b.id === bankId) ?? null);
  const hasFee = type === 'card_swipe' || type === 'card_withdrawal';

  const save = async () => {
    const amountPaisa = toPaisa(amount);
    if (amountPaisa <= 0) return setError('Enter an amount greater than zero.');
    if (cardOnline && !creditCategory)
      return setError('Mark one category as Credit in Settings first, so card purchases have a home.');
    const feePaisa = hasFee ? toPaisa(fee) : 0;
    if (feePaisa > amountPaisa) return setError('The fee cannot be bigger than the amount.');
    if (!cycleId) return;

    setSaving(true);
    const input = {
      type,
      amount: amountPaisa,
      fee: feePaisa,
      date,
      account_id: category?.id ?? null,
      bank_id: bank?.id ?? null,
      place: type === 'expense' ? place : null,
      source: type === 'income' ? source : null,
      note,
    };
    if (editingId) await updateTransaction(db, editingId, input);
    else await addTransaction(db, cycleId, input);
    if (type === 'expense') {
      if (category) await setSetting(db, 'last_account_id', String(category.id));
      if (bank) await setSetting(db, 'last_bank_id', String(bank.id));
    }
    success();
    router.back();
  };

  const remove = () =>
    Alert.alert('Delete this entry?', `${formatPKR(toPaisa(amount))} will be removed from your totals.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deleteTransaction(db, editingId!);
          router.back();
        },
      },
    ]);

  const saveLabel = options.find((o) => o.type === type)?.save ?? 'Save entry';

  const footer = locked ? null : (
    <View style={{ gap: Spacing.two }}>
      <Button label={editingId ? 'Save changes' : saveLabel} onPress={save} disabled={saving} />
      {editingId ? <Button label="Delete entry" variant="danger" onPress={remove} /> : null}
    </View>
  );

  return (
    <Screen style={{ gap: Spacing.four }} footer={footer}>
      <ModalHeader
        title={editingId ? 'Edit entry' : cardScope ? 'Card entry' : 'New entry'}
        onSave={locked ? undefined : save}
        saveDisabled={saving}
      />

      {locked ? (
        <Card>
          <Txt variant="dim">This entry belongs to a closed cycle, so it is read-only.</Txt>
        </Card>
      ) : null}

      <View style={styles.segments}>
        {options.map((o) => {
          const selected = type === o.type;
          return (
            <Press
              key={o.type}
              onPress={() => selectType(o.type)}
              style={[styles.segment, selected && styles.segmentOn]}>
              <Txt
                numberOfLines={1}
                adjustsFontSizeToFit
                style={{ fontSize: 13, fontWeight: selected ? '700' : '500', color: selected ? c.text : c.textDim }}>
                {o.label}
              </Txt>
            </Press>
          );
        })}
      </View>

      {!editingId && !cardScope && type === 'expense' && quick.length > 0 ? (
        <View style={{ gap: Spacing.two + 2 }}>
          <Txt variant="label">Quick add</Txt>
          <ChipRow>
            {quick.map((q) => (
              <Chip
                key={q.id}
                label={q.name}
                selected={false}
                onPress={() => router.replace({ pathname: '/quick', params: { id: String(q.id) } })}
              />
            ))}
          </ChipRow>
        </View>
      ) : null}

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
            editable={!locked}
            placeholder="0"
            placeholderTextColor={withAlpha(c.textDim, 0.4)}
            keyboardType="decimal-pad"
            autoFocus={!editingId}
            selectionColor={c.text}
            style={[
              styles.amountInput,
              {
                fontFamily: fonts.display,
                fontSize: Math.round(44 * fonts.scale),
                letterSpacing: fonts.displaySpacing,
              },
              type === 'income' && { color: c.income },
            ]}
          />
        </View>
        {error ? (
          <Txt variant="dim" color={c.danger}>
            {error}
          </Txt>
        ) : cardOnline ? (
          <Txt variant="small">{ONLINE_HINT}</Txt>
        ) : HINT[type] ? (
          <Txt variant="small">{HINT[type]}</Txt>
        ) : null}
      </View>

      {hasFee ? (
        <Field
          label="Fee charged"
          optional
          value={fee}
          onChangeText={setFee}
          editable={!locked}
          placeholder="0"
          keyboardType="decimal-pad"
        />
      ) : null}

      {type === 'expense' ? (
        <Field
          label="Where did you spend"
          optional
          value={place}
          onChangeText={setPlace}
          editable={!locked}
          placeholder="e.g. Grocery store"
        />
      ) : null}

      {type === 'income' ? (
        <View style={{ gap: Spacing.two + 2 }}>
          <Txt variant="label">
            Source<Txt variant="small">{'   optional'}</Txt>
          </Txt>
          <ChipRow>
            {INCOME_SOURCES.map((s) => (
              <Chip
                key={s}
                label={s}
                selected={source === s}
                onPress={() => !locked && setSource(source === s ? '' : s)}
              />
            ))}
          </ChipRow>
          {!INCOME_SOURCES.includes(source) ? (
            <Field
              label="Or type a source"
              value={source}
              onChangeText={setSource}
              editable={!locked}
              placeholder="e.g. Freelance gig"
            />
          ) : null}
        </View>
      ) : null}

      {categoryChoices.length > 0 ? (
        <View style={{ gap: Spacing.two + 2 }}>
          <Txt variant="label">
            Category<Txt variant="small">{'   optional'}</Txt>
          </Txt>
          <ChipRow>
            {categoryChoices.map((x) => (
              <Chip
                key={x.id}
                label={x.name}
                dot={categoryColor(x.name, x.kind, c)}
                selected={category?.id === x.id}
                onPress={() => !locked && setCategoryId(category?.id === x.id ? null : x.id)}
              />
            ))}
          </ChipRow>
        </View>
      ) : null}

      {onCard && !cardOnline ? (
        <Txt variant="small">
          Charged to your credit card, so it also appears on the Credit screen as Online and adds to what you owe. No
          bank needed.
        </Txt>
      ) : onCard ? null : bankChoices.length > 0 ? (
        <View style={{ gap: Spacing.two + 2 }}>
          <Txt variant="label">
            {BANK_LABEL[type]}
            <Txt variant="small">{'   optional'}</Txt>
          </Txt>
          <ChipRow>
            {bankChoices.map((b) => (
              <Chip
                key={b.id}
                label={b.name}
                selected={bank?.id === b.id}
                onPress={() => !locked && setBankId(bank?.id === b.id ? null : b.id)}
              />
            ))}
          </ChipRow>
        </View>
      ) : null}

      <DateChips value={date} onChange={(d) => setDate(d ?? todayISO())} />

      <Field
        label="Note"
        optional
        value={note}
        onChangeText={setNote}
        editable={!locked}
        placeholder="Anything to remember"
        multiline
      />
    </Screen>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    segments: {
      flexDirection: 'row',
      padding: 3,
      borderRadius: Radius.md,
      backgroundColor: c.surfaceHigh,
    },
    segment: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: Radius.md - 3 },
    segmentOn: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
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
    },
  });
