import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { ProgressBar } from '@/components/charts';
import { TxRow } from '@/components/tx-row';
import { Button, Card, Divider, Empty, Header, Reveal, Row, Screen, SectionTitle, Txt } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { getActiveCycle, getCardSummary, listCardTransactions } from '@/db/queries';
import { useFocusLoad } from '@/hooks/use-focus-load';
import { useColors } from '@/hooks/use-theme';
import { formatPKR } from '@/lib/money';

/**
 * The three ways the card gets used. POS and Online are purchases: the same thing as an expense entered on Home
 * with the Credit Card category, so both show up here. Credit → Debit moves money off the card into a bank; it
 * adds to what you owe but is not spending (spending it is an expense under the Credit → Debit category).
 */
const CATEGORIES = [
  { key: 'pos', type: 'expense', label: 'POS' },
  { key: 'online', type: 'expense', label: 'Online' },
  { key: 'creditToDebit', type: 'card_swipe', label: 'Credit → Debit' },
] as const;

export default function CreditScreen() {
  const c = useColors();
  const router = useRouter();

  const { data } = useFocusLoad(async (db) => {
    const cycle = (await getActiveCycle(db))!;
    const [card, txs] = await Promise.all([getCardSummary(db, cycle.id), listCardTransactions(db, cycle.id)]);
    return { card, txs };
  });

  if (!data) return <Screen tabs>{null}</Screen>;
  const { card, txs } = data;

  const hasLimit = card.limit > 0;
  const overLimit = hasLimit && card.owed > card.limit;
  const usedPct = hasLimit ? Math.round((card.owed / card.limit) * 100) : 0;

  let i = 0;
  return (
    <Screen tabs>
      <Reveal index={i++}>
        <Header eyebrow="Credit card" title="What you owe" />
      </Reveal>

      <Reveal index={i++}>
        <Card style={{ gap: Spacing.three }}>
          <View style={{ gap: 6 }}>
            <Txt variant="label">Balance owed</Txt>
            <Txt variant="hero" color={c.credit} numberOfLines={1} adjustsFontSizeToFit>
              {formatPKR(card.owed)}
            </Txt>
          </View>

          {hasLimit ? (
            <View style={{ gap: Spacing.two + 2 }}>
              <ProgressBar fraction={card.usedFraction} color={overLimit ? c.danger : c.credit} height={4} />
              <Row style={{ justifyContent: 'space-between' }}>
                <Txt variant="small">
                  {usedPct}% of {formatPKR(card.limit)} limit
                </Txt>
                <Txt variant="small" color={overLimit ? c.danger : c.text} style={{ fontWeight: '600' }}>
                  {overLimit
                    ? `Over by ${formatPKR(card.owed - card.limit)}`
                    : `${formatPKR(card.available)} available`}
                </Txt>
              </Row>
            </View>
          ) : (
            <Txt variant="dim" style={{ fontWeight: '600' }} onPress={() => router.push('/settings')}>
              Set your credit limit ›
            </Txt>
          )}
        </Card>
      </Reveal>

      <Reveal index={i++}>
        <View style={{ gap: Spacing.two + 2 }}>
          <Row>
            {CATEGORIES.map((k) => (
              <Button
                key={k.key}
                label={k.label}
                variant="ghost"
                style={{ flex: k.key === 'creditToDebit' ? 1.7 : 1 }}
                onPress={() =>
                  router.push({ pathname: '/add', params: { scope: 'card', type: k.type, channel: k.key } })
                }
              />
            ))}
          </Row>
          <Button
            label="Record a payment"
            onPress={() => router.push({ pathname: '/add', params: { scope: 'card', type: 'card_payment' } })}
          />
        </View>
      </Reveal>

      <Reveal index={i++}>
        <SectionTitle>This cycle</SectionTitle>
        <Card style={{ marginTop: Spacing.two, gap: 0, paddingVertical: Spacing.one }}>
          {CATEGORIES.map((k) => (
            <View key={k.key}>
              <Line label={k.label} value={card[k.key]} strong />
              <Divider />
            </View>
          ))}
          <Line label="Spent under Credit → Debit" value={card.creditToDebitSpent} />
          <Divider />
          <Line label="Payments" value={card.payments} />
        </Card>
      </Reveal>

      <Reveal index={i++}>
        <SectionTitle>Card activity</SectionTitle>
        <Card style={{ paddingVertical: Spacing.one, marginTop: Spacing.two }}>
          {txs.length === 0 ? (
            <Empty>No card activity this cycle.</Empty>
          ) : (
            txs.map((tx, n) => (
              <TxRow
                key={tx.id}
                tx={tx}
                cardView
                last={n === txs.length - 1}
                onPress={() => router.push({ pathname: '/add', params: { id: String(tx.id) } })}
              />
            ))
          )}
        </Card>
      </Reveal>
    </Screen>
  );
}

function Line({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <Row style={{ justifyContent: 'space-between', paddingVertical: Spacing.three - 2 }}>
      <Txt variant={strong ? 'body' : 'dim'} style={strong ? { fontWeight: '600' } : undefined}>
        {label}
      </Txt>
      <Txt style={{ fontWeight: '600' }}>{formatPKR(value)}</Txt>
    </Row>
  );
}
