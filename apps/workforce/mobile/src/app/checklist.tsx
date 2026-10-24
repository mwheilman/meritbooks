/**
 * Checklist, one item per screen: Pass / Fail / N/A in big buttons, a photo when the item needs
 * one, a note on every failure. Finishing queues the checklist; each failed item becomes a punch
 * item (for roles that can add one — otherwise it stays on the checklist for the supervisor).
 */
import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type { CheckResult, ChecklistSubmitCommand, ChecklistTemplate, PunchCreateCommand } from '@/core/contract';
import { useApp } from '@/state/app';
import { jobById } from '@/state/selectors';
import { Button, Choice, Field, Notice, Pill, Row, Screen, Section } from '@/ui/components';
import { CameraButton, JobPicker, SyncBadge, jobLabel } from '@/ui/chrome';
import { font } from '@/ui/theme';

interface Answer {
  result: CheckResult | null;
  note: string;
  photoIds: string[];
}

export default function Checklist() {
  const app = useApp();
  const { t, today, lang } = app;
  const params = useLocalSearchParams<{ jobId?: string }>();
  const [jobId, setJobId] = useState<string | null>(params.jobId || app.currentJobId);
  const [tpl, setTpl] = useState<ChecklistTemplate | null>(null);
  const [runId, setRunId] = useState(() => app.newId());
  const [i, setI] = useState(0);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: 'ok' | 'danger' | 'sky' } | null>(null);
  const job = jobById(today, jobId);

  const offered = useMemo(() => (today?.checklists ?? []).filter((c) => job?.checklists.includes(c.key)), [today, job]);

  if (!tpl) {
    return (
      <Screen title={t('checklists')} right={<SyncBadge />} footer={<Button label={t('back')} onPress={() => router.back()} />}>
        {msg ? <Notice text={msg.text} tone={msg.tone} /> : null}
        <Section title={t('pickJob')}>
          <JobPicker jobs={today?.jobs ?? []} value={jobId} onChange={setJobId} />
        </Section>
        {job ? (
          <Section title={t('checklists')}>
            {!offered.length ? <Text style={font.muted}>{t('noChecklists')}</Text> : null}
            {offered.map((c) => (
              <Row key={c.key} title={c.title[lang]} sub={`${c.items.length} ${t('items')}`} onPress={() => { setTpl(c); setI(0); setAnswers({}); setRunId(app.newId()); setMsg(null); }} />
            ))}
          </Section>
        ) : null}
      </Screen>
    );
  }

  const item = tpl.items[i]!;
  const a: Answer = answers[item.key] ?? { result: null, note: '', photoIds: [] };
  const set = (patch: Partial<Answer>) => setAnswers((all) => ({ ...all, [item.key]: { ...a, ...patch } }));
  const needsPhoto = item.photo === 'required' ? a.result !== null && a.result !== 'NA' : item.photo === 'on_fail' ? a.result === 'FAIL' : false;
  const ready = a.result !== null && (!needsPhoto || a.photoIds.length > 0) && (a.result !== 'FAIL' || a.note.trim().length > 0);
  const last = i === tpl.items.length - 1;

  const finish = async () => {
    if (!jobId) return;
    setBusy(true);
    try {
      const items = tpl.items.map((it) => {
        const x = answers[it.key]!;
        return { key: it.key, result: x.result!, note: x.note.trim() || null, photoIds: x.photoIds };
      });
      await app.record<ChecklistSubmitCommand>({ id: runId, kind: 'checklist.submit', jobId, templateKey: tpl.key, items });
      const failed = items.filter((x) => x.result === 'FAIL');
      if (today?.can.punch) {
        for (const f of failed) {
          const it = tpl.items.find((x) => x.key === f.key)!;
          await app.record<PunchCreateCommand>(
            { kind: 'punch.create', jobId, title: it.text.en.slice(0, 200), description: f.note, fromChecklist: { commandId: runId, itemKey: f.key } },
            { dependsOn: runId },
          );
        }
      }
      setTpl(null);
      setMsg({
        text: !failed.length ? t('checklistDoneClean') : today?.can.punch ? t('checklistDone', { fails: failed.length, items: failed.length === 1 ? t('item') : t('items') }) : `${t('saved')}. ${t('punchNotAllowed')}`,
        tone: failed.length ? 'sky' : 'ok',
      });
    } catch (e) {
      setMsg({ text: t('error', { reason: e instanceof Error ? e.message : '' }), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      title={tpl.title[lang]}
      right={<SyncBadge />}
      overlay={needsPhoto || item.photo === 'optional' ? (
        <CameraButton jobId={jobId} attachTo={{ kind: 'checklist', commandId: runId }} onTaken={(id) => set({ photoIds: [...a.photoIds, id] })} />
      ) : undefined}
      footer={
        <View style={{ gap: 10, paddingRight: 88 }}>
          {msg ? <Notice text={msg.text} tone={msg.tone} /> : null}
          <Button big tone="primary" label={last ? t('finish') : t('next')} disabled={!ready} busy={busy} onPress={() => (last ? void finish() : setI(i + 1))} />
          <Button label={t('back')} onPress={() => (i === 0 ? setTpl(null) : setI(i - 1))} />
        </View>
      }
    >
      <Text style={font.eyebrow}>{t('itemOf', { n: i + 1, total: tpl.items.length })}{job ? ` · ${jobLabel(job)}` : ''}</Text>
      <Text style={font.hero}>{item.text[lang]}</Text>
      <Choice
        options={[{ value: 'PASS' as const, label: t('pass'), tone: 'ok' as const }, { value: 'FAIL' as const, label: t('fail'), tone: 'danger' as const }, { value: 'NA' as const, label: t('na') }]}
        value={a.result}
        onChange={(r) => set({ result: r })}
      />
      {needsPhoto ? <Pill tone={a.photoIds.length ? 'ok' : 'warn'} text={a.photoIds.length ? t('photoTaken', { n: a.photoIds.length }) : t('photoRequired')} /> : null}
      {a.result === 'FAIL' ? <Field label={t('whatIsWrong')} value={a.note} onChangeText={(v) => set({ note: v })} multiline maxLength={1000} /> : null}
    </Screen>
  );
}
