import { View } from 'react-native';

import { Row, Txt } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import type { BankTotal } from '@/db/queries';
import { formatPKR } from '@/lib/money';

/** Spending paid from each bank. Plain rows: banks are where the money came from, not a category. */
export function BankList({ banks }: { banks: BankTotal[] }) {
  return (
    <View style={{ gap: Spacing.three - 4 }}>
      {banks.map((b) => (
        <Row key={b.id} style={{ justifyContent: 'space-between' }}>
          <Txt numberOfLines={1} style={{ flex: 1 }}>
            {b.name}
          </Txt>
          <Txt style={{ fontWeight: '600' }}>{formatPKR(b.total)}</Txt>
        </Row>
      ))}
    </View>
  );
}
