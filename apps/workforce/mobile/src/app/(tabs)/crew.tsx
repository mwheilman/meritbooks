/**
 * Crew time (supervisors): submitted hours from the crew, by person and day. Approve some or
 * all; the approval is queued like any other write and applied once. Hours only — no rates.
 */
import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import type { CrewApproveCommand } from '@/core/contract';
import { useApp } from '@/state/app';
import { dayLabel, hoursText, jobById } from '@/state/selectors';
import { Button, Notice, Pill, Row, Screen, Section } from '@/ui/components';
import { SyncBadge, jobLabel } from '@/ui/chrome';
import { font } from '@/ui/theme';

export default function CrewTime() {
  const app = useApp();
  const { t, today, lang, queued } = app;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: 'ok' | 'danger' | 'sky' } | null>(null);

  // Hide entries whose approval is already queued on this phone.
  const pendingApprove = useMemo(() => {
    const ids = new Set<string>();
    for (const q of queued) if (q.command.kind === 'crew.approve' && (q.status === 'pending' || q.status === 'sending' || q.status === 'done')) q.command.entryIds.forEach((id) => ids.add(id));
    return ids;
  }, [queued]);
  const rows = (today?.crewTime ?? []).filter((e) => !pendingApprove.has(e.id));
  const byPerson = useMemo(() => {
    const m = new Map<string, typeof rows>();
    for (const r of rows) m.set(r.person, [...(m.get(r.person) ?? []), r]);
    return [...m.entries()];
  }, [rows]);

  const approve = async (ids: string[]) => {
    if (!ids.length) return;
    setBusy(true);
    try {
      await app.record<CrewApproveCommand>({ kind: 'crew.approve', entryIds: ids }, { geo: null });
      setSelected(new Set());
      setMsg({ text: app.online ? t('saved') : t('savedOffline'), tone: app.online ? 'ok' : 'sky' });
    } catch (e) {
      setMsg({ text: t('error', { reason: e instanceof Error ? e.message : '' }), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  if (!today?.can.approveTime) {
    return <Screen title={t('crewTitle')} right={<SyncBadge />}><Text style={font.muted}>{t('nothingToApprove')}</Text></Screen>;
  }

  return (
    <Screen
      title={t('crewTitle')}
      right={<SyncBadge />}
      footer={rows.length ? (
        <View style={{ gap: 10 }}>
          {msg ? <Notice text={msg.text} tone={msg.tone} /> : null}
          {selected.size ? <Button big tone="primary" label={t('approveSelected', { n: selected.size })} busy={busy} onPress={() => void approve([...selected])} /> : null}
          <Button big={!selected.size} tone={selected.size ? 'secondary' : 'primary'} label={t('approveAll')} busy={busy && !selected.size} onPress={() => void approve(rows.map((r) => r.id))} />
        </View>
      ) : msg ? <Notice text={msg.text} tone={msg.tone} /> : undefined}
    >
      {!rows.length ? <Text style={font.muted}>{t('nothingToApprove')}</Text> : null}
      {byPerson.map(([person, list]) => (
        <Section key={person} title={person} right={<Pill text={t('hoursShort', { h: hoursText(list.reduce((s, e) => s + e.hours, 0)) })} />}>
          {list.map((e) => {
            const j = jobById(today, e.jobId);
            const on = selected.has(e.id);
            return (
              <Row
                key={e.id}
                title={`${dayLabel(e.workDate, lang)} · ${t('hoursShort', { h: hoursText(e.hours) })}`}
                sub={[j ? jobLabel(j) : null, e.notes].filter(Boolean).join(' · ') || null}
                selected={on}
                onPress={() => setSelected((s) => {
                  const n = new Set(s);
                  if (on) n.delete(e.id);
                  else n.add(e.id);
                  return n;
                })}
              />
            );
          })}
        </Section>
      ))}
    </Screen>
  );
}
