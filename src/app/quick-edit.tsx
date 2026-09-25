import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { Alert, View } from 'react-native';

import { Button, Chip, ChipRow, Field, ModalHeader, Screen, Txt } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import {
  addQuick,
  archiveQuick,
  getQuick,
  listAccounts,
  listBanks,
  updateQuick,
  type Account,
  type Bank,
} from '@/db/queries';
import { useColors } from '@/hooks/use-theme';
import { success } from '@/lib/haptics';
import { categoryColor } from '@/lib/labels';

/** Create or edit a quick add: its name, and optionally the category and bank it should use. */
export default function QuickEditScreen() {
  const c = useColors();
  const db = useSQLiteContext();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const editingId = id ? Number(id) : null;

  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [bankId, setBankId] = useState<number | null>(null);
  const [categories, setCategories] = useState<Account[]>([]);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [cats, bks] = await Promise.all([listAccounts(db), listBanks(db)]);
      setCategories(cats);
      setBanks(bks);
      if (editingId) {
        const q = await getQuick(db, editingId);
        if (!q) return router.back();
        setName(q.name);
        setCategoryId(q.account_id);
        setBankId(q.bank_id);
      }
    })();
  }, [db, editingId, router]);

  const category = categories.find((x) => x.id === categoryId) ?? null;
  // A credit-card expense is not paid from a bank.
  const onCard = category?.kind === 'credit';
  const bank = onCard ? null : (banks.find((b) => b.id === bankId) ?? null);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return setError('Give it a name, like Food or Fuel.');
    if (editingId) await updateQuick(db, editingId, trimmed, category?.id ?? null, bank?.id ?? null);
    else await addQuick(db, trimmed, category?.id ?? null, bank?.id ?? null);
    success();
    router.back();
  };

  const remove = () =>
    Alert.alert(`Remove ${name}?`, 'Entries you already saved with it stay as they are.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await archiveQuick(db, editingId!);
          router.back();
        },
      },
    ]);

  return (
    <Screen
      style={{ gap: Spacing.four }}
      footer={
        <View style={{ gap: Spacing.two }}>
          <Button label={editingId ? 'Save changes' : 'Add quick add'} onPress={save} />
          {editingId ? <Button label="Remove" variant="danger" onPress={remove} /> : null}
        </View>
      }>
      <ModalHeader title={editingId ? 'Edit quick add' : 'New quick add'} onSave={save} />

      <Field
        label="Name"
        value={name}
        onChangeText={(v) => {
          setName(v);
          setError(null);
        }}
        placeholder="e.g. Food, Fuel, Groceries"
        autoFocus={!editingId}
      />
      {error ? (
        <Txt variant="dim" color={c.danger}>
          {error}
        </Txt>
      ) : null}

      <View style={{ gap: Spacing.two + 2 }}>
        <Txt variant="label">
          Category<Txt variant="small">{'   optional'}</Txt>
        </Txt>
        <ChipRow>
          {categories.map((x) => (
            <Chip
              key={x.id}
              label={x.name}
              dot={categoryColor(x.name, x.kind, c)}
              selected={category?.id === x.id}
              onPress={() => setCategoryId(category?.id === x.id ? null : x.id)}
            />
          ))}
        </ChipRow>
      </View>

      {onCard ? (
        <Txt variant="small">Charged to your credit card, so it also shows on the Credit screen. No bank needed.</Txt>
      ) : (
        <View style={{ gap: Spacing.two + 2 }}>
          <Txt variant="label">
            Paid from<Txt variant="small">{'   optional'}</Txt>
          </Txt>
          <ChipRow>
            {banks.map((b) => (
              <Chip
                key={b.id}
                label={b.name}
                selected={bank?.id === b.id}
                onPress={() => setBankId(bank?.id === b.id ? null : b.id)}
              />
            ))}
          </ChipRow>
        </View>
      )}

      <Txt variant="small">
        When you use this quick add you only type the amount (and a date if it isn’t today). The category and bank above
        are filled in for you.
      </Txt>
    </Screen>
  );
}
