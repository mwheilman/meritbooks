/** Bottom tabs: Today · Clock · Daily log · Crew time (supervisors) · Me. Tall labels, no tiny icons. */
import { Tabs } from 'expo-router/js-tabs';
import { useApp } from '@/state/app';
import { color } from '@/ui/theme';

export default function TabsLayout() {
  const { t, today } = useApp();
  const supervisor = !!today?.can.approveTime;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: color.primary,
        tabBarInactiveTintColor: color.muted,
        tabBarStyle: { height: 76, paddingTop: 6, paddingBottom: 14, borderTopColor: color.line, backgroundColor: color.bg },
        tabBarLabelStyle: { fontSize: 16, fontWeight: '700' },
        tabBarIconStyle: { display: 'none' },
        tabBarIcon: () => null,
      }}
    >
      <Tabs.Screen name="index" options={{ title: t('tabToday') }} />
      <Tabs.Screen name="clock" options={{ title: t('tabClock') }} />
      <Tabs.Screen name="log" options={{ title: t('tabLog') }} />
      <Tabs.Screen name="crew" options={{ title: t('tabCrew'), href: supervisor ? undefined : null }} />
      <Tabs.Screen name="me" options={{ title: t('tabMe') }} />
    </Tabs>
  );
}
