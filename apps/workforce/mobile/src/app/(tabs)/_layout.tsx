/** Bottom tabs: Today · Clock · Daily log · Approve (when anything can wait on me) · Me. Tall labels, no tiny icons. */
import { useMemo } from 'react';
import { Tabs } from 'expo-router/js-tabs';
import { actionable } from '@/core/approvals';
import { useApp } from '@/state/app';
import { color } from '@/ui/theme';

export default function TabsLayout() {
  const { t, today, approvals, queued } = useApp();
  const waiting = useMemo(() => {
    const crew = new Set((today?.crewTime ?? []).map((e) => e.id));
    return actionable(approvals?.items ?? [], queued, crew).length + (today?.crewTime.length ?? 0);
  }, [approvals?.items, queued, today?.crewTime]);
  const supervisor = !!today?.can.approveTime || waiting > 0 || (approvals?.counts.mine ?? 0) > 0;
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
      <Tabs.Screen name="crew" options={{ title: t('tabApprove'), href: supervisor ? undefined : null, tabBarBadge: waiting > 0 ? (waiting > 99 ? '99+' : waiting) : undefined }} />
      <Tabs.Screen name="me" options={{ title: t('tabMe') }} />
    </Tabs>
  );
}
