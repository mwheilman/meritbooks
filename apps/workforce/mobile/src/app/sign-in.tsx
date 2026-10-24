/**
 * Sign in with a one-time code by email or text message (no password). Uses Clerk's sign-in
 * flow against the suite's Clerk instance; the person must already be a member (invited by the
 * office) — the phone never creates accounts.
 */
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Text, View } from 'react-native';
import { useSignIn } from '@clerk/expo/legacy';
import { translate, type Lang } from '@/core/i18n';
import { deviceLang } from '@/lib/device';
import { Button, Field, Notice, Screen } from '@/ui/components';
import { font } from '@/ui/theme';

type Factor = { strategy: 'email_code'; emailAddressId: string } | { strategy: 'phone_code'; phoneNumberId: string };

function clerkMessage(e: unknown): string {
  const errs = typeof e === 'object' && e !== null ? (e as { errors?: Array<{ longMessage?: string; message?: string; code?: string }> }).errors : undefined;
  const first = errs?.[0];
  if (first?.code === 'form_identifier_not_found') return 'NOT_FOUND';
  return first?.longMessage ?? first?.message ?? (e instanceof Error ? e.message : 'Try again.');
}

export default function SignIn() {
  const { isLoaded, signIn, setActive } = useSignIn();
  const [lang] = useState<Lang>(deviceLang());
  const t = (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate(lang, k, v);
  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [factor, setFactor] = useState<Factor | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPhone = /^[+\d][\d\s().-]{6,}$/.test(identifier.trim());

  const send = async () => {
    if (!isLoaded || !signIn) return;
    setBusy(true);
    setError(null);
    try {
      const id = identifier.trim();
      const attempt = await signIn.create({ identifier: isPhone ? id.replace(/[\s().-]/g, '') : id.toLowerCase() });
      const factors = attempt.supportedFirstFactors ?? [];
      const email = factors.find((f) => f.strategy === 'email_code');
      const phone = factors.find((f) => f.strategy === 'phone_code');
      let f: Factor | null = null;
      if (isPhone && phone && 'phoneNumberId' in phone) f = { strategy: 'phone_code', phoneNumberId: phone.phoneNumberId };
      else if (email && 'emailAddressId' in email) f = { strategy: 'email_code', emailAddressId: email.emailAddressId };
      else if (phone && 'phoneNumberId' in phone) f = { strategy: 'phone_code', phoneNumberId: phone.phoneNumberId };
      if (!f) throw new Error('Code sign-in is not turned on for this account. Ask your office.');
      await signIn.prepareFirstFactor(f);
      setFactor(f);
    } catch (e) {
      const m = clerkMessage(e);
      setError(m === 'NOT_FOUND' ? t('noAccount') : t('signInFailed', { reason: m }));
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!isLoaded || !signIn || !factor) return;
    setBusy(true);
    setError(null);
    try {
      const r = await signIn.attemptFirstFactor({ strategy: factor.strategy, code: code.trim() });
      if (r.status === 'complete' && r.createdSessionId) await setActive({ session: r.createdSessionId });
      else setError(t('signInFailed', { reason: 'This account needs another sign-in step. Ask your office.' }));
    } catch (e) {
      setError(t('signInFailed', { reason: clerkMessage(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen
        title={t('appName')}
        footer={
          factor ? (
            <>
              <Button tone="primary" big label={t('verify')} onPress={() => void verify()} busy={busy} disabled={code.trim().length < 4} />
              <Button label={t('useDifferent')} onPress={() => { setFactor(null); setCode(''); setError(null); }} />
            </>
          ) : (
            <Button tone="primary" big label={t('sendCode')} onPress={() => void send()} busy={busy} disabled={!identifier.trim() || !isLoaded} />
          )
        }
      >
        <View style={{ gap: 12 }}>
          <Text style={font.hero}>{t('signInTitle')}</Text>
          <Text style={font.regular}>{t('signInBody')}</Text>
        </View>
        {factor ? (
          <>
            <Text style={font.regular}>{t('codeSentTo', { to: identifier.trim() })}</Text>
            <Field label={t('enterCode')} value={code} onChangeText={setCode} keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code" maxLength={8} autoFocus />
          </>
        ) : (
          <Field label={t('emailOrPhone')} value={identifier} onChangeText={setIdentifier} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" textContentType="username" autoComplete="email" returnKeyType="send" onSubmitEditing={() => void send()} />
        )}
        {error ? <Notice text={error} tone="danger" /> : null}
      </Screen>
    </KeyboardAvoidingView>
  );
}
