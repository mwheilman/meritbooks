/**
 * Customer sign-off on the technician's phone (e-sign, migration 1115): pick a PDF on the job,
 * type the customer's name, hand over the phone. The customer reads the document (saved on the
 * phone, so it opens with no signal), agrees to sign electronically, types their name and draws
 * their signature. The signature is queued (`esign.sign`) and sent the moment there is signal;
 * the office gets the signed PDF with the audit certificate as usual.
 *
 * Starting needs signal once (the office makes the one-time signing request and the document).
 */
import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type { EsignSignCommand, SignableFile, StartedSigning } from '@/core/contract';
import { absoluteUrl, pngDataUrl, signDraft, signMissing } from '@/core/esign';
import { PROJECTS_API, isFiles } from '@/lib/api';
import { openFile, removeFile, saveSigningDoc } from '@/lib/files';
import type { File } from 'expo-file-system';
import { useApp } from '@/state/app';
import { useCached } from '@/state/cache';
import { jobById } from '@/state/selectors';
import { Button, Card, Field, Notice, Pill, Row, Screen, Section } from '@/ui/components';
import { SyncBadge, jobLabel } from '@/ui/chrome';
import { SignaturePad, type SignatureExport } from '@/ui/SignaturePad';
import { font } from '@/ui/theme';

type Stage = { kind: 'pick' } | { kind: 'customer'; session: StartedSigning; file: File | null } | { kind: 'thanks' };

export default function Sign() {
  const app = useApp();
  const { t, today } = app;
  const { jobId = app.currentJobId ?? '' } = useLocalSearchParams<{ jobId?: string }>();
  const files = useCached<{ files: SignableFile[] }>(jobId ? `sign.files.${jobId}` : null, isFiles, () => app.api.signFiles(jobId), app.online);
  const [docId, setDocId] = useState<string | null>(null);
  const [signer, setSigner] = useState('');
  const [stage, setStage] = useState<Stage>({ kind: 'pick' });
  const [consent, setConsent] = useState(false);
  const [name, setName] = useState('');
  const [drawn, setDrawn] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pad = useRef<SignatureExport>(null);
  const job = jobById(today, jobId);

  const start = async () => {
    if (!docId || signer.trim().length < 2) return setErr(t('signNeedName'));
    setBusy(true);
    setErr(null);
    try {
      const doc = files.value?.files.find((f) => f.id === docId);
      const session = await app.api.signStart({ documentId: docId, signerName: signer.trim(), title: doc?.title ?? null });
      const url = absoluteUrl(PROJECTS_API, session.fileUrl);
      const file = url ? await saveSigningDoc(session.envelopeId, url) : null;
      setName(signer.trim());
      setConsent(false);
      setDrawn(false);
      setStage({ kind: 'customer', session, file });
    } catch (e) {
      setErr(t('signFailed', { reason: e instanceof Error ? e.message : '' }));
    } finally {
      setBusy(false);
    }
  };

  const sign = async () => {
    if (stage.kind !== 'customer') return;
    const missing = signMissing({ consent, name, drawn });
    if (missing.length) return setErr(t(missing[0] === 'consent' ? 'signNeedConsent' : missing[0] === 'name' ? 'signNeedName' : 'signNeedDrawing'));
    setBusy(true);
    try {
      const png = pngDataUrl((await pad.current?.png()) ?? '');
      if (!png) return setErr(t('signNeedDrawing'));
      await app.record<EsignSignCommand>(signDraft(stage.session.token, name, png), { geo: null });
      // the customer's copy of the document does not stay on the technician's phone
      if (stage.file) removeFile(stage.file.uri);
      setStage({ kind: 'thanks' });
      setErr(null);
    } catch (e) {
      setErr(t('error', { reason: e instanceof Error ? e.message : '' }));
    } finally {
      setBusy(false);
    }
  };

  if (stage.kind === 'thanks') {
    return (
      <Screen title={t('signTitle')} right={<SyncBadge />} footer={<Button big tone="primary" label={t('done')} onPress={() => router.back()} />}>
        <Card tone="ok"><Text style={font.hero}>{t('signThanks')}</Text></Card>
        {!app.online ? <Notice text={t('savedOffline')} tone="sky" /> : null}
      </Screen>
    );
  }

  if (stage.kind === 'customer') {
    const st = stage.session.state;
    return (
      <Screen
        title={st.company?.company_name ?? t('signTitle')}
        footer={
          <View style={{ gap: 10 }}>
            {err ? <Notice text={err} tone="danger" /> : null}
            <Button big tone="primary" label={t('signSubmit')} busy={busy} onPress={() => void sign()} />
            <Button label={t('cancel')} onPress={() => { if (stage.file) removeFile(stage.file.uri); setStage({ kind: 'pick' }); }} />
          </View>
        }
      >
        <Text style={font.title}>{t('signFor', { title: st.envelope?.title ?? st.document?.title ?? '' })}</Text>
        {stage.file ? <Button label={t('signOpenDoc')} tone="secondary" onPress={() => void openFile(stage.file!)} /> : <Notice text={t('signNeedsSignal')} />}
        <Row title={st.consent?.text ?? t('signConsent')} selected={consent} onPress={() => setConsent((c) => !c)} right={<Pill text={consent ? t('yes') : t('no')} tone={consent ? 'ok' : 'muted'} />} />
        <Field label={t('signTypeName')} value={name} onChangeText={setName} autoCapitalize="words" maxLength={120} />
        <SignaturePad label={t('signDraw')} clearLabel={t('clearSignature')} onChange={(p) => setDrawn(!!p)} exportRef={pad} />
      </Screen>
    );
  }

  const list = files.value?.files ?? [];
  return (
    <Screen
      title={t('signTitle')}
      right={<SyncBadge />}
      footer={
        <View style={{ gap: 10 }}>
          {err ? <Notice text={err} tone="danger" /> : null}
          {docId ? <Button big tone="primary" label={t('signStart')} busy={busy} disabled={!app.online} onPress={() => void start()} /> : null}
          <Button label={t('back')} onPress={() => router.back()} />
        </View>
      }
    >
      {job ? <Text style={font.strong}>{jobLabel(job)}</Text> : null}
      {!app.online ? <Notice text={t('signNeedsSignal')} tone="sky" /> : null}
      <Section title={t('signPickDoc')}>
        {files.loading && !list.length ? <Text style={font.muted}>{t('loadingWork')}</Text> : null}
        {!files.loading && !list.length ? <Text style={font.muted}>{t('signNoDocs')}</Text> : null}
        {list.map((f) => (
          <Row key={f.id} title={f.title} sub={f.fileName} selected={docId === f.id} onPress={() => setDocId(f.id)}
            right={f.signature ? <Pill text={t(`sigStatus_${f.signature}`)} tone={f.signature === 'completed' ? 'ok' : f.signature === 'declined' ? 'danger' : 'warn'} /> : null} />
        ))}
      </Section>
      {docId ? <Field label={t('customerName')} value={signer} onChangeText={setSigner} autoCapitalize="words" maxLength={120} /> : null}
    </Screen>
  );
}
