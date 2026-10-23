'use client';

import { useEffect, useState } from 'react';
import { Button, ButtonRow, Drawer, Field, InlineNotice, PanelSection, Radio, Switch, Textarea } from '@meritbooks/merit-ui';
import { addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import { CopyAddress } from '@/components/inbound-email/copy-address';
import { PURPOSE_LABEL, type InboxAlias, type SenderRule } from '@/components/inbound-email/types';

const RULES: Array<{ value: SenderRule; label: string; help: string }> = [
  { value: 'any', label: 'Anyone can send', help: 'Best for a bills inbox you give to every vendor. Duplicates and spam are still filtered.' },
  { value: 'known_vendors', label: 'Only known vendors and your team', help: 'The sender must be a vendor email on file, from a vendor’s company domain, or a member of your team.' },
  { value: 'listed_domains', label: 'Only the domains and people I list (plus your team)', help: 'Tightest. Anything else is refused and not stored.' },
];

function lines(s: string): string[] {
  return s.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
}

/** Edit one address: on/off and who may send to it. settings_system:edit only. */
export function AliasRulesDrawer({ alias, onClose, onSaved }: { alias: InboxAlias | null; onClose: () => void; onSaved: (a: InboxAlias) => void }) {
  const [active, setActive] = useState(true);
  const [rule, setRule] = useState<SenderRule>('any');
  const [domains, setDomains] = useState('');
  const [senders, setSenders] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  useEffect(() => {
    if (!alias) return;
    setActive(alias.isActive);
    setRule(alias.senderRule);
    setDomains(alias.allowedDomains.join('\n'));
    setSenders(alias.allowedSenders.join('\n'));
    setError(null);
    setFieldErrors({});
  }, [alias]);

  if (!alias) return null;

  const domainList = lines(domains);
  const senderList = lines(senders);
  const listEmpty = rule === 'listed_domains' && domainList.length === 0 && senderList.length === 0;

  async function save() {
    if (!alias) return;
    setSaving(true);
    setError(null);
    setFieldErrors({});
    const res = await api.patch<{ alias: InboxAlias }>('/api/inbound-email/aliases', {
      alias_id: alias.id,
      is_active: active,
      sender_rule: rule,
      allowed_domains: domainList,
      allowed_senders: senderList,
    });
    setSaving(false);
    if (res.data?.alias) {
      addToast('success', `Saved ${alias.address}`);
      onSaved(res.data.alias);
      onClose();
      return;
    }
    const details = res.error?.details ?? {};
    setFieldErrors(details);
    setError(res.status === 403 ? 'Only an administrator can change inbox settings.' : res.error?.error ?? 'Could not save.');
  }

  return (
    <Drawer
      open
      onClose={onClose}
      width={480}
      eyebrow={[alias.companyName, PURPOSE_LABEL[alias.purpose]]}
      title="Inbox settings"
      foot={
        <ButtonRow>
          <Button variant="primary" onClick={() => void save()} disabled={saving || listEmpty}>{saving ? 'Saving…' : 'Save'}</Button>
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
        </ButtonRow>
      }
    >
      <PanelSection title="Address">
        <CopyAddress address={alias.address} />
        <div style={{ marginTop: 12 }}>
          <Switch label={active ? 'Accepting mail' : 'Switched off — mail to this address is refused and not stored'} checked={active} onChange={(e) => setActive(e.currentTarget.checked)} />
        </div>
      </PanelSection>

      <PanelSection title="Who can send to it">
        <div role="radiogroup" aria-label="Who can send">
          {RULES.map((r) => (
            <div key={r.value} style={{ marginBottom: 8 }}>
              <Radio name={`rule-${alias.id}`} label={r.label} checked={rule === r.value} onChange={() => setRule(r.value)} />
              <p className="t-cap" style={{ marginLeft: 32 }}>{r.help}</p>
            </div>
          ))}
        </div>
        {rule !== 'any' && (
          <>
            {rule === 'listed_domains' && (
              <Field label="Allowed domains" help="One per line, e.g. acmesupply.com. Sub-domains are included." error={fieldErrors.allowed_domains?.join(' ')}>
                <Textarea value={domains} onChange={(e) => setDomains(e.currentTarget.value)} rows={4} placeholder={'acmesupply.com\nprairiedrywall.com'} />
              </Field>
            )}
            <Field label="Always allow these senders" help="One email address per line (useful for vendors on Gmail)." error={fieldErrors.allowed_senders?.join(' ')}>
              <Textarea value={senders} onChange={(e) => setSenders(e.currentTarget.value)} rows={3} placeholder="owner@gmail.com" />
            </Field>
            <p className="t-cap">Your team can always forward bills here.</p>
          </>
        )}
        {listEmpty && (
          <div style={{ marginTop: 8 }}>
            <InlineNotice tone="warn" title="Add at least one domain or sender.">Otherwise only your team could send to this address.</InlineNotice>
          </div>
        )}
      </PanelSection>

      {error && <InlineNotice tone="neg" title="Not saved.">{error}</InlineNotice>}
    </Drawer>
  );
}
