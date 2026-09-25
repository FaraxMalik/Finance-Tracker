import { Tabs } from 'expo-router';

import { FloatingTabBar } from '@/components/tab-bar';
import { useColors } from '@/hooks/use-theme';

export default function TabsLayout() {
  const c = useColors();
  return (
    <Tabs
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: c.bg } }}>
      <Tabs.Screen name="index" options={{ title: 'Home' }} />
      <Tabs.Screen name="credit" options={{ title: 'Credit' }} />
      <Tabs.Screen name="debts" options={{ title: 'Debts' }} />
      <Tabs.Screen name="history" options={{ title: 'History' }} />
    </Tabs>
  );
}
