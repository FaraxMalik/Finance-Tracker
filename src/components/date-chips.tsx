import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { Platform, View } from 'react-native';

import { Chip, ChipRow, Txt } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { addDays, longDate, parseISODate, toISODate, todayISO } from '@/lib/dates';

/**
 * Today / Yesterday / Pick date.
 *
 * `value` is an ISO date, or `null` meaning "today" (so a form can resolve it at save time and always get the
 * real current date). `onChange(null)` is sent when "Today" is chosen.
 */
export function DateChips({ value, onChange }: { value: string | null; onChange: (date: string | null) => void }) {
  const today = todayISO();
  const isToday = value === null || value === today;
  const isYesterday = value === addDays(today, -1);
  const custom = !isToday && !isYesterday;

  const pick = () => {
    // The native picker only exists on Android; elsewhere (web preview) use the Today/Yesterday chips.
    if (Platform.OS !== 'android') return;
    DateTimePickerAndroid.open({
      value: parseISODate(value ?? today),
      mode: 'date',
      maximumDate: new Date(),
      onChange: (_, picked) => picked && onChange(toISODate(picked)),
    });
  };

  return (
    <View style={{ gap: Spacing.two + 2 }}>
      <Txt variant="label">Date</Txt>
      <ChipRow>
        <Chip label="Today" selected={isToday} onPress={() => onChange(null)} />
        <Chip label="Yesterday" selected={isYesterday} onPress={() => onChange(addDays(today, -1))} />
        <Chip label={custom ? longDate(value!) : 'Pick date'} selected={custom} onPress={pick} />
      </ChipRow>
    </View>
  );
}
