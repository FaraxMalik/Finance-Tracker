import { usePathname, useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CardIcon, HistoryIcon, HomeIcon, PeopleIcon, PlusIcon } from '@/components/icons';
import { Press, Txt } from '@/components/ui';
import type { Palette } from '@/constants/theme';
import { useColors, useStyles } from '@/hooks/use-theme';

// Only what the bar needs from React Navigation's tab-bar props.
type BarProps = {
  state: { index: number; routes: { key: string; name: string; params?: object }[] };
  navigation: {
    emit: (e: { type: 'tabPress'; target: string; canPreventDefault: true }) => { defaultPrevented: boolean };
    navigate: (name: string, params?: object) => void;
  };
};

const TABS: Record<string, { label: string; icon: (color: string) => ReactNode }> = {
  index: { label: 'Home', icon: (c) => <HomeIcon color={c} size={22} /> },
  credit: { label: 'Credit', icon: (c) => <CardIcon color={c} size={22} /> },
  debts: { label: 'Debts', icon: (c) => <PeopleIcon color={c} size={22} /> },
  history: { label: 'History', icon: (c) => <HistoryIcon color={c} size={22} /> },
};

/**
 * The + button does the most useful thing for the tab you're on:
 *  Credit -> card entries only (online, swipe, withdrawal, payment); Debts -> a debt entry; otherwise an expense.
 */
function addTarget(pathname: string): { pathname: string; params?: Record<string, string> } {
  if (pathname.startsWith('/debts')) return { pathname: '/debt-entry' };
  if (pathname.startsWith('/credit')) return { pathname: '/add', params: { scope: 'card' } };
  return { pathname: '/add' };
}

export function FloatingTabBar({ state, navigation }: BarProps) {
  const c = useColors();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname();

  const renderTab = (route: BarProps['state']['routes'][number]) => {
    const meta = TABS[route.name];
    if (!meta) return null;
    const focused = state.routes[state.index]?.key === route.key;
    const color = focused ? c.text : c.textDim;

    const onPress = () => {
      const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
      if (!focused && !event.defaultPrevented) navigation.navigate(route.name, route.params);
    };

    return (
      <Press key={route.key} onPress={onPress} accessibilityLabel={meta.label} style={styles.tab}>
        {meta.icon(color)}
        <Txt style={{ fontSize: 10.5, fontWeight: focused ? '700' : '500', color }}>{meta.label}</Txt>
      </Press>
    );
  };

  const half = Math.ceil(state.routes.length / 2);

  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
      {state.routes.slice(0, half).map(renderTab)}
      <View style={styles.centerSlot}>
        <Press onPress={() => router.push(addTarget(pathname))} accessibilityLabel="Add" style={styles.plus}>
          <PlusIcon color={c.onAccent} size={24} />
        </Press>
      </View>
      {state.routes.slice(half).map(renderTab)}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingTop: 8,
      backgroundColor: c.surface,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    tab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, paddingVertical: 2 },
    centerSlot: { width: 76, alignItems: 'center', justifyContent: 'center' },
    plus: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: c.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
