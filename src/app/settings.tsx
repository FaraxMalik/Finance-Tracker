import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { Alert, StyleSheet, TextInput, View } from 'react-native';

import { Button, Card, Chip, ChipRow, Field, ModalHeader, Row, Screen, SectionTitle, Txt } from '@/components/ui';
import { fontSets, Radius, Spacing, withAlpha, type FontChoice, type Palette } from '@/constants/theme';
import {
  addAccount,
  addBank,
  archiveAccount,
  archiveBank,
  exportBackup,
  getCycleStartDay,
  getNumberSetting,
  listAccounts,
  listBanks,
  listQuick,
  renameBank,
  restoreBackup,
  setSetting,
  updateAccount,
  type Account,
  type Bank,
} from '@/db/queries';
import { useFocusLoad } from '@/hooks/use-focus-load';
import { useStyles, useTheme, type ThemeMode } from '@/hooks/use-theme';
import { todayISO } from '@/lib/dates';
import { shareTextFile } from '@/lib/export';
import { fromPaisa, toPaisa } from '@/lib/money';

const FONT_OPTIONS: FontChoice[] = ['mono', 'serif', 'classic'];

const THEME_OPTIONS: { mode: ThemeMode; label: string }[] = [
  { mode: 'system', label: 'System' },
  { mode: 'light', label: 'Light' },
  { mode: 'dark', label: 'Dark' },
];

export default function SettingsScreen() {
  const styles = useStyles(makeStyles);
  const { colors: c, fonts, mode, setMode, font, setFont } = useTheme();
  const db = useSQLiteContext();
  const router = useRouter();

  const [limit, setLimit] = useState('');
  const [opening, setOpening] = useState('');
  const [startDay, setStartDay] = useState('5');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [newAccount, setNewAccount] = useState('');
  const [banks, setBanks] = useState<Bank[]>([]);
  const [newBank, setNewBank] = useState('');
  const [saved, setSaved] = useState(false);
  const { data: quick } = useFocusLoad((d) => listQuick(d));

  const loadAccounts = async () => setAccounts(await listAccounts(db));
  const loadBanks = async () => setBanks(await listBanks(db));

  useEffect(() => {
    (async () => {
      setLimit(fromPaisa(await getNumberSetting(db, 'credit_limit')));
      setOpening(fromPaisa(await getNumberSetting(db, 'card_opening_balance')));
      setStartDay(String(await getCycleStartDay(db)));
      await loadAccounts();
      await loadBanks();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db]);

  const saveCard = async () => {
    const day = Math.round(Number(startDay));
    if (!Number.isFinite(day) || day < 1 || day > 28)
      return Alert.alert('Cycle start day', 'Use a day between 1 and 28.');
    await setSetting(db, 'credit_limit', String(toPaisa(limit)));
    await setSetting(db, 'card_opening_balance', String(toPaisa(opening)));
    await setSetting(db, 'cycle_start_day', String(day));
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  const add = async () => {
    if (!newAccount.trim()) return;
    await addAccount(db, newAccount.trim(), 'debit');
    setNewAccount('');
    await loadAccounts();
  };

  const addNewBank = async () => {
    if (!newBank.trim()) return;
    await addBank(db, newBank.trim());
    setNewBank('');
    await loadBanks();
  };

  const backup = async () => {
    try {
      const data = await exportBackup(db);
      await shareTextFile(`finance-tracker-backup-${todayISO()}.json`, JSON.stringify(data), 'application/json');
    } catch (e) {
      Alert.alert('Backup failed', e instanceof Error ? e.message : 'Something went wrong.');
    }
  };

  const restore = async () => {
    const res = await DocumentPicker.getDocumentAsync({
      type: ['application/json', 'text/*', '*/*'],
      copyToCacheDirectory: true,
    });
    if (res.canceled) return;
    Alert.alert('Replace all data?', 'Everything currently in the app will be replaced by the backup file.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Restore',
        style: 'destructive',
        onPress: async () => {
          try {
            const text = await new File(res.assets[0].uri).text();
            await restoreBackup(db, JSON.parse(text));
            Alert.alert('Restored', 'Your data has been restored.', [
              { text: 'OK', onPress: () => router.replace('/') },
            ]);
          } catch (e) {
            Alert.alert('Restore failed', e instanceof Error ? e.message : 'That file could not be read.');
          }
        },
      },
    ]);
  };

  return (
    <Screen>
      <ModalHeader title="Settings" />

      <SectionTitle>Appearance</SectionTitle>
      <Card style={{ gap: Spacing.three }}>
        <ChipRow>
          {THEME_OPTIONS.map((o) => (
            <Chip key={o.mode} label={o.label} selected={mode === o.mode} onPress={() => setMode(o.mode)} />
          ))}
        </ChipRow>
        <Txt variant="small">System follows your phone’s light or dark setting.</Txt>
        <Txt variant="label" style={{ marginTop: Spacing.one }}>
          Typeface
        </Txt>
        <ChipRow>
          {FONT_OPTIONS.map((f) => (
            <Chip key={f} label={fontSets[f].label} selected={font === f} onPress={() => setFont(f)} />
          ))}
        </ChipRow>
        <Txt variant="small">Mono lines up digits in neat columns. Serif is softer. Classic is the first look.</Txt>
      </Card>

      <SectionTitle>Credit card</SectionTitle>
      <Card style={{ gap: Spacing.three }}>
        <Field
          label="Total credit limit (Rs)"
          value={limit}
          onChangeText={setLimit}
          keyboardType="decimal-pad"
          placeholder="0"
        />
        <Field
          label="Already owed on card (Rs)"
          value={opening}
          onChangeText={setOpening}
          keyboardType="decimal-pad"
          placeholder="0"
        />
        <Txt variant="small">
          The second number is what you owed before you started using this app. New card use is added on top of it.
        </Txt>
        <Field
          label="Cycle starts on day"
          value={startDay}
          onChangeText={setStartDay}
          keyboardType="number-pad"
          placeholder="5"
        />
        <Button label={saved ? 'Saved' : 'Save'} onPress={saveCard} />
      </Card>

      <SectionTitle>Categories</SectionTitle>
      <Card style={{ gap: Spacing.three }}>
        <Txt variant="small">Only categories marked Credit count as credit spending. Everything else is debit.</Txt>
        {accounts.map((a) => (
          <AccountRow
            key={a.id}
            account={a}
            onChange={async (name, kind) => {
              await updateAccount(db, a.id, name, kind);
              await loadAccounts();
            }}
            onRemove={() =>
              Alert.alert(`Remove ${a.name}?`, 'It disappears from the picker. Past entries keep their history.', [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Remove',
                  style: 'destructive',
                  onPress: async () => {
                    await archiveAccount(db, a.id);
                    await loadAccounts();
                  },
                },
              ])
            }
          />
        ))}
        <Row>
          <View style={{ flex: 1 }}>
            <TextInput
              value={newAccount}
              onChangeText={setNewAccount}
              placeholder="Add a category"
              placeholderTextColor={withAlpha(c.textDim, 0.6)}
              onSubmitEditing={add}
              style={[styles.input, { fontFamily: fonts.regular }]}
            />
          </View>
          <Button label="Add" variant="ghost" onPress={add} disabled={!newAccount.trim()} style={{ minHeight: 48 }} />
        </Row>
      </Card>

      <SectionTitle>Banks</SectionTitle>
      <Card style={{ gap: Spacing.three }}>
        <Txt variant="small">Where the money moves through. Shown as “Paid from” on each entry.</Txt>
        {banks.map((b) => (
          <BankRow
            key={b.id}
            bank={b}
            onRename={async (name) => {
              await renameBank(db, b.id, name);
              await loadBanks();
            }}
            onRemove={() =>
              Alert.alert(`Remove ${b.name}?`, 'It disappears from the picker. Past entries keep their bank.', [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Remove',
                  style: 'destructive',
                  onPress: async () => {
                    await archiveBank(db, b.id);
                    await loadBanks();
                  },
                },
              ])
            }
          />
        ))}
        <Row>
          <View style={{ flex: 1 }}>
            <TextInput
              value={newBank}
              onChangeText={setNewBank}
              placeholder="Add a bank"
              placeholderTextColor={withAlpha(c.textDim, 0.6)}
              onSubmitEditing={addNewBank}
              style={[styles.input, { fontFamily: fonts.regular }]}
            />
          </View>
          <Button
            label="Add"
            variant="ghost"
            onPress={addNewBank}
            disabled={!newBank.trim()}
            style={{ minHeight: 48 }}
          />
        </Row>
      </Card>

      <SectionTitle>Quick add</SectionTitle>
      <Card style={{ gap: Spacing.three }}>
        <Txt variant="small">Shortcuts on Home: pick one, type the amount, done. Tap one to change what it uses.</Txt>
        {(quick ?? []).map((q) => (
          <Row key={q.id} style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Txt style={{ fontWeight: '600' }}>{q.name}</Txt>
              <Txt variant="small">
                {[q.account_name ?? 'Uncategorised', q.account_kind === 'credit' ? null : q.bank_name]
                  .filter(Boolean)
                  .join(' · ')}
              </Txt>
            </View>
            <Txt
              variant="dim"
              style={{ fontWeight: '600' }}
              onPress={() => router.push({ pathname: '/quick-edit', params: { id: String(q.id) } })}>
              Edit
            </Txt>
          </Row>
        ))}
        <Button label="Add a quick add" variant="ghost" onPress={() => router.push('/quick-edit')} />
      </Card>

      <SectionTitle>Backup</SectionTitle>
      <Card>
        <Txt variant="small">
          Your data lives only on this phone. Export a backup now and then and keep it somewhere safe, like Google
          Drive.
        </Txt>
        <Button label="Export backup" onPress={backup} />
        <Button label="Restore from backup" variant="ghost" onPress={restore} />
      </Card>
    </Screen>
  );
}

function BankRow({ bank, onRename, onRemove }: { bank: Bank; onRename: (name: string) => void; onRemove: () => void }) {
  const { colors: c, fonts } = useTheme();
  const styles = useStyles(makeStyles);
  const [name, setName] = useState(bank.name);
  return (
    <Row>
      <View style={{ flex: 1 }}>
        <TextInput
          value={name}
          onChangeText={setName}
          onEndEditing={() => name.trim() && name.trim() !== bank.name && onRename(name.trim())}
          style={[styles.input, { fontFamily: fonts.regular }]}
        />
      </View>
      <Txt variant="dim" color={c.danger} onPress={onRemove}>
        Remove
      </Txt>
    </Row>
  );
}

function AccountRow({
  account,
  onChange,
  onRemove,
}: {
  account: Account;
  onChange: (name: string, kind: Account['kind']) => void;
  onRemove: () => void;
}) {
  const { colors: c, fonts } = useTheme();
  const styles = useStyles(makeStyles);
  const [name, setName] = useState(account.name);
  return (
    <View style={{ gap: Spacing.two }}>
      <TextInput
        value={name}
        onChangeText={setName}
        onEndEditing={() => name.trim() && name.trim() !== account.name && onChange(name.trim(), account.kind)}
        style={[styles.input, { fontFamily: fonts.regular }]}
      />
      <Row>
        <Chip
          label="Debit"
          selected={account.kind === 'debit'}
          onPress={() => onChange(name.trim() || account.name, 'debit')}
        />
        <Chip
          label="Credit"
          selected={account.kind === 'credit'}
          onPress={() => onChange(name.trim() || account.name, 'credit')}
        />
        <View style={{ flex: 1 }} />
        <Txt variant="dim" color={c.danger} onPress={onRemove}>
          Remove
        </Txt>
      </Row>
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    input: {
      minHeight: 48,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.bg,
      color: c.text,
      fontSize: 16,
      paddingHorizontal: Spacing.three,
    },
  });
