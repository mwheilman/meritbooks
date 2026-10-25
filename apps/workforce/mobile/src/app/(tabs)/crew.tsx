/**
 * Approve (supervisors, PMs, owners): everything waiting on me from the approvals engine —
 * change orders, purchase orders, billing, draws, estimates, deals, time — one card each with
 * Approve / Send back at thumb reach (under 10 seconds an item), then my crew's submitted hours.
 * Every answer is queued like any other write (offline-safe; the server applies it once, and a
 * re-send after the step moved on is recognised). Amounts show only when the engine says they are
 * mine to see; crew time is hours only.
 */
import { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ApprovalDecideCommand, ApprovalItem, CrewApproveCommand } from '@/core/contract';
import { actionable, decisionDraft, flagsOf, needsReason, refusedHere, shownAmount } from '@/core/approvals';
import type { StringKey } from '@/core/i18n';
import { moneyText } from '@/core/money';
import { useApp } from '@/state/app';
import { agoText, dayLabel, hoursText, jobById, timeOf } from '@/state/selectors';
import { Button, Card, Field, Notice, Pill, Row, Section, s } from '@/ui/components';
import { InboxBell, SyncBadge, jobLabel } from '@/ui/chrome';
import { font } from '@/ui/theme';

type Msg = { text: string; tone: 'ok' | 'danger' | 'sky' } | null;

function typeKey(t: string): StringKey {
  const k = `type_${t}`;
  return (['type_change_order', 'type_commitment', 'type_commitment_change', 'type_billing_request', 'type_draw', 'type_time_entry', 'type_estimate', 'type_budget_transfer', 'type_dealer_deal', 'type_stage_transition'] as const).find((x) => x === k) ?? 'approvalsSection';
}

function ApprovalCard({ item, onDecide }: { item: ApprovalItem; onDecide: (i: ApprovalItem, d: 'approve' | 'reject', reason: string | null) => Promise<void> }) {
  const { t, lang } = useApp();
  const [mode, setMode] = useState<'idle' | 'approve' | 'reject'>('idle');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const amount = shownAmount(item);
  const flags = flagsOf(item);

  const go = async (d: 'approve' | 'reject') => {
    if (needsReason(item, d) && mode !== d) {
      setMode(d);
      setErr(null);
      return;
    }
    if (needsReason(item, d) && !reason.trim()) {
      setErr(t('reasonNeeded'));
      return;
    }
    setBusy(true);
    await onDecide(item, d, reason.trim() || null);
    setBusy(false);
  };

  return (
    <Card tone={item.overdue ? 'warn' : undefined}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
        <Text style={font.eyebrow}>{t(typeKey(item.object_type))}</Text>
        {item.step_count > 1 ? <Text style={font.muted}>{t('stepOf', { n: item.step, total: item.step_count })}</Text> : null}
      </View>
      <Text style={font.title}>{item.title}</Text>
      {item.job_label || item.company ? <Text style={font.regular}>{[item.job_label, item.company].filter(Boolean).join(' · ')}</Text> : null}
      {item.summary ? <Text style={font.muted} numberOfLines={3}>{item.summary}</Text> : null}
      {amount != null ? <Text style={font.hero}>{moneyText(amount, lang)}</Text> : null}
      {item.facts?.hours != null ? <Text style={font.regular}>{t('hoursShort', { h: hoursText(item.facts.hours) })}</Text> : null}
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        {flags.map((f) => <Pill key={f} text={t(`flag_${f}`)} tone={f === 'overdue' || f === 'over_budget' || f === 'below_margin_floor' ? 'danger' : 'warn'} />)}
        {item.submitted_by ? <Pill text={t('fromWho', { name: item.submitted_by })} /> : null}
        {item.due_at ? <Pill text={t('dueWhen', { when: `${dayLabel(item.due_at.slice(0, 10), lang)} ${timeOf(item.due_at, lang) ?? ''}`.trim() })} /> : null}
      </View>
      {mode !== 'idle' ? (
        <Field label={mode === 'reject' ? t('sendBackWhy') : t('approveWhy')} value={reason} onChangeText={setReason} multiline autoFocus maxLength={2000} />
      ) : null}
      {err ? <Notice text={err} tone="danger" /> : null}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}><Button label={t('sendBack')} tone={mode === 'reject' ? 'danger' : 'secondary'} busy={busy && mode === 'reject'} onPress={() => void go('reject')} /></View>
        <View style={{ flex: 1.4 }}><Button label={t('approve')} tone="ok" busy={busy && mode !== 'reject'} onPress={() => void go('approve')} /></View>
      </View>
    </Card>
  );
}

export default function Approve() {
  const app = useApp();
  const { t, today, lang, queued, approvals } = app;
  const insets = useSafeAreaInsets();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [pulling, setPulling] = useState(false);

  const say = (m: Msg) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 2500);
  };

  // ---- crew time (hours only); entries whose approval is already queued are hidden
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

  // ---- approvals engine
  const crewIds = useMemo(() => new Set((today?.crewTime ?? []).map((e) => e.id)), [today?.crewTime]);
  const items = useMemo(() => actionable(approvals?.items ?? [], queued, crewIds), [approvals?.items, queued, crewIds]);
  const refused = refusedHere(queued);

  const decide = async (i: ApprovalItem, d: 'approve' | 'reject', reason: string | null) => {
    try {
      await app.record<ApprovalDecideCommand>(decisionDraft(i, d, reason), { geo: null });
      say({ text: d === 'approve' ? t('approvedSaved') : t('sentBackSaved'), tone: app.online ? 'ok' : 'sky' });
    } catch (e) {
      say({ text: t('error', { reason: e instanceof Error ? e.message : '' }), tone: 'danger' });
    }
  };

  const approveCrew = async (ids: string[]) => {
    if (!ids.length) return;
    setBusy(true);
    try {
      await app.record<CrewApproveCommand>({ kind: 'crew.approve', entryIds: ids }, { geo: null });
      setSelected(new Set());
      say({ text: app.online ? t('saved') : t('savedOffline'), tone: app.online ? 'ok' : 'sky' });
    } catch (e) {
      say({ text: t('error', { reason: e instanceof Error ? e.message : '' }), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const nothing = !items.length && !rows.length;

  return (
    <View style={[s.screen, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Text style={font.title} accessibilityRole="header">{t('approveTitle')}</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}><InboxBell /><SyncBadge /></View>
      </View>
      <ScrollView
        contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={async () => { setPulling(true); await app.flush(); await app.refresh(); setPulling(false); }} />}
      >
        {!app.online && app.approvalsAt ? <Notice text={t('approvalsSaved', { when: agoText(app.approvalsAt, lang) })} tone="sky" /> : null}
        {refused.map((r) => (
          <Card key={r.id} tone="danger">
            <Text style={font.regular}>{t('approvalRefused', { reason: r.reason })}</Text>
            <Button label={t('clear')} onPress={() => void app.dismiss(r.id)} />
          </Card>
        ))}
        {nothing ? <Text style={font.muted}>{t('approvalsNone')}</Text> : null}

        {items.length ? (
          <Section title={t('approvalsSection')} right={<Pill text={String(items.length)} tone="primary" />}>
            {items.map((i) => <ApprovalCard key={i.id} item={i} onDecide={decide} />)}
          </Section>
        ) : null}

        {rows.length ? (
          <Section title={t('crewTitle')}>
            {byPerson.map(([person, list]) => (
              <View key={person} style={{ gap: 8 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={font.strong}>{person}</Text>
                  <Pill text={t('hoursShort', { h: hoursText(list.reduce((n, e) => n + e.hours, 0)) })} />
                </View>
                {list.map((e) => {
                  const j = jobById(today, e.jobId);
                  const on = selected.has(e.id);
                  return (
                    <Row
                      key={e.id}
                      title={`${dayLabel(e.workDate, lang)} · ${t('hoursShort', { h: hoursText(e.hours) })}`}
                      sub={[j ? jobLabel(j) : null, e.notes].filter(Boolean).join(' · ') || null}
                      selected={on}
                      onPress={() => setSelected((cur) => {
                        const nx = new Set(cur);
                        if (on) nx.delete(e.id);
                        else nx.add(e.id);
                        return nx;
                      })}
                    />
                  );
                })}
              </View>
            ))}
            {selected.size ? <Button big tone="primary" label={t('approveSelected', { n: selected.size })} busy={busy} onPress={() => void approveCrew([...selected])} /> : null}
            <Button big={!selected.size} tone={selected.size ? 'secondary' : 'primary'} label={t('approveAll')} busy={busy && !selected.size} onPress={() => void approveCrew(rows.map((r) => r.id))} />
          </Section>
        ) : null}
      </ScrollView>
      {msg ? <View style={s.footer}><Notice text={msg.text} tone={msg.tone} /></View> : null}
    </View>
  );
}
