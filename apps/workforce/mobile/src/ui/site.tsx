/**
 * Today's "before you knock" card and job actions (Wave C): the customer's words and the site's
 * access (gate code, pets) for a service visit; the occupied-home rules a lead carpenter lives by
 * (lockbox and alarm codes, pets, children, work hours, parking, off-limits rooms, lead-safe
 * rules); and the buttons for what this job has — options to present, drawings, customer
 * sign-off, repair orders. All from the cached extras, so it shows with no signal. No money.
 */
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import type { StringKey } from '@/core/i18n';
import { useApp } from '@/state/app';
import { Button, Card, Notice, Pill } from './components';
import { font } from './theme';

function Line({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
      <Text style={font.strong}>{label}</Text>
      <Text style={[font.regular, { flex: 1 }]}>{value}</Text>
    </View>
  );
}

export function SiteCard({ jobId, workOrderId }: { jobId: string | null; workOrderId: string | null }) {
  const { t, extras, more } = useApp();
  const visit = workOrderId ? extras?.visits[workOrderId] : undefined;
  const home = jobId ? extras?.homes[jobId] : undefined;
  const site = jobId ? extras?.sites?.[jobId] : undefined;
  // the lead carpenter's site card (GET /api/field/site): tasks today, deliveries with tracking
  const card = jobId ? more.siteCards.find((c) => c.job_id === jobId) : undefined;
  if (!visit && !home && !site && !card) return null;
  const codes: Array<[StringKey, string | null]> = home ? [['lockbox', home.lockboxCode], ['gate', home.gateCode ?? visit?.gateCode ?? null], ['garage', home.garageCode], ['alarm', home.alarmCode]] : [['gate', visit?.gateCode ?? null]];
  const rules: Array<[StringKey, string | null]> = [
    ['customerSays', visit?.complaint ?? null], ['accessNotes', visit?.accessNotes ?? null], ['pets', home?.pets ?? visit?.pets ?? null], ['children', home?.children ?? null],
    ['workHours', home?.workHours ?? null], ['parking', home?.parking ?? null], ['offLimits', home?.offLimits ?? null], ['utilityNotice', home?.utilityNotice ?? null],
    ['tempKitchen', home?.tempKitchen ?? null], ['crewBathroom', home?.bathroomForCrew ?? null],
  ];
  const anything = codes.some(([, v]) => v) || rules.some(([, v]) => v) || home?.rrpRequired || home?.occupied || visit?.member || !!site || !!card;
  if (!anything) return null;
  return (
    <Card>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={font.eyebrow}>{t('siteNotes')}</Text>
        {visit?.member ? <Pill text={t('memberBadge')} tone="ok" /> : null}
      </View>
      {codes.filter(([, v]) => v).length ? (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {codes.filter(([, v]) => v).map(([k, v]) => <Pill key={k} text={`${t(k)} ${v}`} tone="primary" />)}
        </View>
      ) : null}
      {rules.map(([k, v]) => <Line key={k} label={t(k)} value={v} />)}
      {home?.notes ? <Text style={font.muted}>{home.notes}</Text> : null}
      {card
        ? card.deliveries.map((d, i) => <Line key={`d${i}`} label={t('deliveryLabel')} value={[d.description, d.expected_on, d.tracking ? t('tracking', { ref: d.tracking }) : null].filter(Boolean).join(' · ')} />)
        : site?.deliveries.map((d, i) => <Line key={`d${i}`} label={t('deliveryLabel')} value={[d.description, d.expectedOn].filter(Boolean).join(' · ')} />)}
      {(card?.checks_open.length ?? site?.checksOpen ?? 0) > 0 ? <Line label={t('protectionChecks')} value={card ? card.checks_open.map((c) => c.kind.toLowerCase().replace(/_/g, ' ')).join(', ') : String(site?.checksOpen ?? '')} /> : null}
      {card?.tasks_today.length ? <Line label={t('tasksToday')} value={card.tasks_today.map((k) => k.title).join(' · ')} /> : null}
      {home?.rrpRequired || site?.rrpOpen || card?.rrp ? <Notice text={t('rrp')} /> : null}
      {home?.occupied ? <Text style={font.muted}>{t('occupiedHome')}</Text> : null}
    </Card>
  );
}

const SERVICE = new Set(['SERVICE', 'MAINTENANCE_VISIT', 'INSTALL', 'MEASURE', 'INSPECTION']);

export function JobActions({ jobId, workOrderId }: { jobId: string | null; workOrderId: string | null }) {
  const { t, extras, more } = useApp();
  if (!jobId) return null;
  const visit = workOrderId ? extras?.visits[workOrderId] : undefined;
  const sheets = extras?.drawings[jobId] ?? 0;
  const buttons: Array<{ key: string; label: string; go: () => void; primary?: boolean }> = [];
  if (visit && visit.estimates.open > 0 && workOrderId) buttons.push({ key: 'sell', label: t('showOptions'), primary: true, go: () => router.push({ pathname: '/sell', params: { workOrderId } }) });
  if (visit && SERVICE.has(visit.kind) && workOrderId) buttons.push({ key: 'tools', label: t('visitTools'), go: () => router.push({ pathname: '/visit', params: { workOrderId } }) });
  if (more.siteCards.some((c) => c.job_id === jobId)) buttons.push({ key: 'rcpt', label: t('receiptBtn'), go: () => router.push({ pathname: '/receipt', params: { jobId } }) });
  if (visit && (visit.kind === 'REPAIR_ORDER' || visit.kind === 'PDI')) buttons.push({ key: 'ro', label: t('roBtn'), go: () => router.push('/ro') });
  if (sheets > 0 && extras?.features.drawings) buttons.push({ key: 'dwg', label: t('drawingsBtn', { n: sheets }), go: () => router.push({ pathname: '/drawings', params: { jobId } }) });
  if (extras?.features.esign) buttons.push({ key: 'sign', label: t('signOff'), go: () => router.push({ pathname: '/sign', params: { jobId } }) });
  if (!buttons.length) return null;
  return (
    <View style={{ gap: 10 }}>
      {buttons.map((b) => <Button key={b.key} label={b.label} tone={b.primary ? 'primary' : 'secondary'} onPress={b.go} />)}
    </View>
  );
}
