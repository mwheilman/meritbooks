/**
 * The kitchen-table close (field service FS-32/33/34/53): good / better / best options with the
 * regular and member price, rebate and monthly financing payment on each card; add-ons; financing
 * plan; membership on the spot; the customer signs on the phone; deposit (pay link by text, check
 * or cash). The options are cached so the close works with no signal, and the sale is queued as
 * one `fs.sell` command to POST /api/field/fs-commands with the time the customer signed (the drawn
 * signature goes first as a photo it waits for).
 *
 * The prices here are the CUSTOMER-FACING prices the technician presents — never cost or margin.
 */
import { useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type { DepositMethod, FsDeclineCommand, FsSellCommand, PhotoCommand, SellBundle, SellOption } from '@/core/contract';
import { monthlyPaymentCents, moneyText, optionPrice, parseDollars, planFor } from '@/core/money';
import { isSell } from '@/lib/api';
import { writeSignaturePng } from '@/lib/files';
import { useApp } from '@/state/app';
import { useCached } from '@/state/cache';
import { agoText } from '@/state/selectors';
import { Button, Card, Choice, Field, Notice, Pill, Row, Screen, Section } from '@/ui/components';
import { SyncBadge } from '@/ui/chrome';
import { SignaturePad, type SignatureExport } from '@/ui/SignaturePad';
import { color, font } from '@/ui/theme';

type Step = 'options' | 'sign' | 'deposit' | 'done' | 'decline';

export default function Sell() {
  const app = useApp();
  const { t, lang } = app;
  const { workOrderId = '' } = useLocalSearchParams<{ workOrderId?: string }>();
  const data = useCached<SellBundle>(workOrderId ? `sell.${workOrderId}` : null, isSell, () => app.api.service(workOrderId), app.online);
  const b = data.value;

  const [step, setStep] = useState<Step>('options');
  const [optionId, setOptionId] = useState<string | null>(null);
  const [toggles, setToggles] = useState<Record<string, boolean>>({});
  const [planId, setPlanId] = useState<string | null>(null);
  const [joinId, setJoinId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [drawn, setDrawn] = useState(false);
  const [method, setMethod] = useState<DepositMethod>('none');
  const [deposit, setDeposit] = useState('');
  const [ref, setRef] = useState('');
  const [why, setWhy] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** When the customer signed (sent as signedAt; the office keeps its own received time too). */
  const [signedAt, setSignedAt] = useState<string | null>(null);
  const pad = useRef<SignatureExport>(null);

  const soldHere = app.queued.find((q) => q.command.kind === 'fs.sell' && b?.estimates.some((e) => e.id === (q.command as FsSellCommand).estimateId) && q.status !== 'dismissed' && q.status !== 'rejected');
  const soldEstimate = b?.estimates.find((e) => e.status === 'SOLD');
  const declinedHere = app.queued.some((q) => q.command.kind === 'fs.decline' && b?.estimates.some((e) => e.id === (q.command as FsDeclineCommand).estimateId) && q.status !== 'dismissed' && q.status !== 'rejected');
  const open = useMemo(() => (b?.options ?? []).filter((o) => o.status === 'OPEN' && b?.estimates.find((e) => e.id === o.estimateId && (e.status === 'DRAFT' || e.status === 'PRESENTED'))), [b]);
  const member = !!b?.member || !!joinId;
  const chosen = open.find((o) => o.id === optionId) ?? null;
  const price = chosen && b ? optionPrice(chosen, b.items, toggles, member) : null;
  const join = b?.memberships.find((m) => m.id === joinId) ?? null;
  const total = (price?.dueCents ?? 0) + (join?.priceCents ?? 0);
  const plan = b?.plans.find((p) => p.id === planId) ?? null;

  const card = (o: SellOption) => {
    const p = optionPrice(o, b!.items, toggles, member);
    const pl = planFor(b!.plans, p.dueCents, o.financingPlanId);
    const on = o.id === optionId;
    return (
      <Card key={o.id} tone={on ? 'sky' : undefined}>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Pill text={t(`tier_${o.tier}`)} tone="primary" />
          {o.recommended ? <Pill text={t('recommended')} tone="ok" /> : null}
        </View>
        <Text style={font.title}>{o.name}</Text>
        {o.description ? <Text style={font.regular}>{o.description}</Text> : null}
        {b!.items.filter((i) => i.optionId === o.id && !i.optional).map((i) => <Text key={i.id} style={font.muted}>{`· ${i.description}${i.qty !== 1 ? ` × ${i.qty}` : ''}`}</Text>)}
        <Text style={[font.hero, { color: color.ink }]}>{moneyText(p.dueCents, lang)}</Text>
        {member ? <Text style={[font.muted, { textDecorationLine: 'line-through' }]}>{t('regularPrice', { amount: moneyText(p.regularCents, lang) })}</Text>
          : p.memberSavingsCents > 0 ? <Text style={[font.strong, { color: color.ok }]}>{t('memberSaves', { amount: moneyText(p.memberSavingsCents, lang) })}</Text> : null}
        {p.rebateCents > 0 ? <Text style={font.regular}>{[t('rebateAmt', { amount: moneyText(p.rebateCents, lang) }), o.rebateNote].filter(Boolean).join(' · ')}</Text> : null}
        {pl ? <Text style={font.strong}>{t('perMonth', { amount: moneyText(monthlyPaymentCents(p.dueCents, pl.apr, pl.termMonths), lang), months: pl.termMonths })}</Text> : null}
        <Button tone={on ? 'primary' : 'secondary'} label={on ? t('chosen') : t('chooseThis')} onPress={() => {
          setOptionId(o.id);
          setPlanId((cur) => cur ?? pl?.id ?? null);
        }} />
      </Card>
    );
  };

  const toSign = () => {
    if (!chosen) return;
    setErr(null);
    setStep('sign');
  };

  const toDeposit = () => {
    if (name.trim().length < 1) return setErr(t('sellNeedsName'));
    if (!drawn) return setErr(t('sellNeedsDrawing'));
    setErr(null);
    setSignedAt(new Date().toISOString());
    setStep('deposit');
  };

  const sell = async () => {
    if (!b || !chosen) return;
    const cents = method === 'none' ? 0 : parseDollars(deposit);
    if (method !== 'none' && (cents == null || cents <= 0)) return setErr(t('depositBad'));
    setBusy(true);
    try {
      // 1) the drawn signature, saved on the phone and queued as a photo the sale waits for
      const photoId = app.newId();
      const png = await pad.current?.png();
      const uri = png ? await writeSignaturePng(photoId, png) : null;
      const est = b.estimates.find((e) => e.id === chosen.estimateId);
      if (uri) {
        await app.record<PhotoCommand>({ id: photoId, kind: 'photo.upload', jobId: b.jobId, caption: `Customer signature${est?.number ? ` · ${est.number}` : ''}`, attachTo: null }, { fileUri: uri, geo: null });
      }
      // 2) the sale
      const optional = b.items.filter((i) => i.optionId === chosen.id && i.optional);
      await app.record<FsSellCommand>({
        kind: 'fs.sell', estimateId: chosen.estimateId, optionIds: [chosen.id], signedAt: signedAt ?? new Date().toISOString(),
        toggles: optional.filter((i) => toggles[i.id] !== undefined && toggles[i.id] !== i.selected).map((i) => ({ itemId: i.id, selected: !!toggles[i.id] })),
        signedName: name.trim(), signaturePhotoId: uri ? photoId : null, financingPlanId: planId, joinTemplateId: b.member ? null : joinId,
        depositCents: cents ?? 0, depositMethod: method, depositRef: ref.trim() || null,
      }, { dependsOn: uri ? photoId : null });
      setStep('done');
    } catch (e) {
      setErr(t('error', { reason: e instanceof Error ? e.message : '' }));
    } finally {
      setBusy(false);
    }
  };

  const decline = async () => {
    const est = open[0]?.estimateId ?? b?.estimates[0]?.id;
    if (!est || !why.trim()) return setErr(t('declineWhy'));
    await app.record<FsDeclineCommand>({ kind: 'fs.decline', estimateId: est, reason: why.trim() });
    setStep('done');
    setErr(null);
  };

  const title = b?.customer ? t('sellFor', { name: b.customer }) : t('sellTitle');

  if (!b) {
    return (
      <Screen title={t('sellTitle')} right={<SyncBadge />} footer={<Button label={t('back')} onPress={() => router.back()} />}>
        <Notice text={data.loading ? t('loadingWork') : t('sellLoadFailed')} tone={data.loading ? 'sky' : 'warn'} />
        {data.error && !data.loading ? <Text style={font.muted}>{data.error}</Text> : null}
      </Screen>
    );
  }

  if (step === 'done' || soldHere || soldEstimate || declinedHere) {
    const doneDecline = declinedHere && !soldHere && !soldEstimate;
    return (
      <Screen title={title} right={<SyncBadge />} footer={<Button big tone="primary" label={t('done')} onPress={() => router.back()} />}>
        <Notice text={doneDecline ? t('declinedSaved') : soldEstimate?.signed_name ? t('alreadySold', { name: soldEstimate.signed_name }) : t('soldSaved')} tone="ok" />
      </Screen>
    );
  }

  return (
    <Screen
      title={title}
      right={<SyncBadge />}
      footer={
        <View style={{ gap: 10 }}>
          {err ? <Notice text={err} tone="danger" /> : null}
          {step === 'options' ? (
            <>
              {chosen ? <Button big tone="primary" label={`${t('next')} · ${moneyText(total, lang)}`} onPress={toSign} /> : null}
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <View style={{ flex: 1 }}><Button label={t('back')} onPress={() => router.back()} /></View>
                {open.length ? <View style={{ flex: 1 }}><Button label={t('declineBtn')} onPress={() => { setErr(null); setStep('decline'); }} /></View> : null}
              </View>
            </>
          ) : step === 'sign' ? (
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}><Button label={t('back')} onPress={() => setStep('options')} /></View>
              <View style={{ flex: 1.4 }}><Button tone="primary" label={t('next')} onPress={toDeposit} /></View>
            </View>
          ) : step === 'deposit' ? (
            <>
              <Button big tone="ok" label={t('sellNow')} busy={busy} onPress={() => void sell()} />
              <Button label={t('back')} onPress={() => setStep('sign')} />
            </>
          ) : (
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}><Button label={t('back')} onPress={() => setStep('options')} /></View>
              <View style={{ flex: 1.4 }}><Button tone="danger" label={t('declineBtn')} onPress={() => void decline()} /></View>
            </View>
          )}
        </View>
      }
    >
      {!app.online && data.at ? <Notice text={t('inboxSaved', { when: agoText(data.at, lang) })} tone="sky" /> : null}

      {step === 'options' ? (
        <>
          {!open.length ? <Notice text={t('noOptions')} /> : null}
          {b.member ? <Pill text={t('memberBadge')} tone="ok" /> : null}
          {open.map(card)}
          {chosen ? (
            <>
              {b.items.some((i) => i.optionId === chosen.id && i.optional) ? (
                <Section title={t('addOns')}>
                  {b.items.filter((i) => i.optionId === chosen.id && i.optional).map((i) => {
                    const on = toggles[i.id] ?? i.selected;
                    const unit = member && i.memberUnitPriceCents != null ? i.memberUnitPriceCents : i.unitPriceCents;
                    return <Row key={i.id} title={i.description} sub={moneyText(Math.round(unit * i.qty), lang)} selected={on} onPress={() => setToggles((c) => ({ ...c, [i.id]: !on }))} />;
                  })}
                </Section>
              ) : null}
              {!b.member && b.memberships.length ? (
                <Section title={t('membership')}>
                  <Row title={t('noMembership')} selected={!joinId} onPress={() => setJoinId(null)} />
                  {b.memberships.map((m) => <Row key={m.id} title={t('joinPlan', { plan: [m.planName, m.tier].filter(Boolean).join(' '), amount: moneyText(m.priceCents, lang) })} selected={joinId === m.id} onPress={() => setJoinId(m.id)} />)}
                </Section>
              ) : null}
              <Section title={t('financing')}>
                <Row title={t('payInFull')} sub={moneyText(total, lang)} selected={!planId} onPress={() => setPlanId(null)} />
                {b.plans.filter((p) => total >= p.minCents && (p.maxCents == null || total <= p.maxCents)).map((p) => (
                  <Row key={p.id} title={p.name} sub={[t('perMonth', { amount: moneyText(monthlyPaymentCents(total, p.apr, p.termMonths), lang), months: p.termMonths }), p.promo].filter(Boolean).join(' · ')} selected={planId === p.id} onPress={() => setPlanId(p.id)} />
                ))}
              </Section>
            </>
          ) : null}
        </>
      ) : null}

      {step === 'sign' && chosen && price ? (
        <>
          <Card tone="sky">
            <Text style={font.eyebrow}>{t('customerPays')}</Text>
            <Text style={font.title}>{chosen.name}{join ? ` + ${join.planName}` : ''}</Text>
            <Text style={font.hero}>{moneyText(total, lang)}</Text>
            {plan ? <Text style={font.strong}>{t('perMonth', { amount: moneyText(monthlyPaymentCents(total, plan.apr, plan.termMonths), lang), months: plan.termMonths })}</Text> : null}
          </Card>
          <Text style={font.regular}>{t('agreeWork')}</Text>
          <Field label={t('customerName')} value={name} onChangeText={setName} autoCapitalize="words" maxLength={120} />
          <SignaturePad label={t('customerSigns')} clearLabel={t('clearSignature')} onChange={(p) => setDrawn(!!p)} exportRef={pad} />
        </>
      ) : null}

      {step === 'deposit' ? (
        <Section title={t('depositTitle')}>
          <Choice options={[{ value: 'none' as const, label: t('depositNone') }, { value: 'link' as const, label: t('depositLink') }]} value={method === 'none' || method === 'link' ? method : null} onChange={setMethod} />
          <Choice options={[{ value: 'check' as const, label: t('depositCheck') }, { value: 'cash' as const, label: t('depositCash') }]} value={method === 'check' || method === 'cash' ? method : null} onChange={setMethod} />
          {method !== 'none' ? <Field label={t('depositAmount')} value={deposit} onChangeText={setDeposit} keyboardType="decimal-pad" maxLength={12} /> : null}
          {method === 'check' ? <Field label={t('checkNumber')} value={ref} onChangeText={setRef} maxLength={60} /> : null}
        </Section>
      ) : null}

      {step === 'decline' ? <Field label={t('declineWhy')} value={why} onChangeText={setWhy} multiline maxLength={300} autoFocus /> : null}
    </Screen>
  );
}
