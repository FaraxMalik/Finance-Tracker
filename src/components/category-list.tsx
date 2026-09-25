import { StyleSheet, View } from 'react-native';

import { StackBar } from '@/components/charts';
import { Divider, Dot, Row, Txt } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import type { CategoryTotal } from '@/db/queries';
import { useColors } from '@/hooks/use-theme';
import { categoryColor } from '@/lib/labels';
import { formatPKR } from '@/lib/money';

/** Each category's own total and share, then the overall total underneath. */
export function CategoryList({ breakdown, total }: { breakdown: CategoryTotal[]; total: number }) {
  const c = useColors();
  if (breakdown.length === 0) {
    return <Txt variant="dim">Nothing spent yet.</Txt>;
  }
  return (
    <View style={{ gap: Spacing.three }}>
      <StackBar segments={breakdown.map((b) => ({ value: b.total, color: categoryColor(b.name, b.kind, c) }))} />
      <View style={{ gap: Spacing.three - 4 }}>
        {breakdown.map((b) => (
          <Row key={b.id ?? 'none'} style={{ gap: Spacing.two + 2 }}>
            <Dot color={categoryColor(b.name, b.kind, c)} />
            <Txt style={{ flex: 1 }} numberOfLines={1}>
              {b.name}
            </Txt>
            <Txt variant="small" style={styles.pct}>
              {total > 0 ? Math.round((b.total / total) * 100) : 0}%
            </Txt>
            <Txt style={[styles.amount, { fontWeight: '600' }]}>{formatPKR(b.total)}</Txt>
          </Row>
        ))}
      </View>
      <Divider />
      <Row style={{ justifyContent: 'space-between' }}>
        <Txt style={{ fontWeight: '700' }}>Total</Txt>
        <Txt style={{ fontWeight: '700' }}>{formatPKR(total)}</Txt>
      </Row>
    </View>
  );
}

const styles = StyleSheet.create({
  pct: { width: 38, textAlign: 'right' },
  amount: { minWidth: 96, textAlign: 'right' },
});
