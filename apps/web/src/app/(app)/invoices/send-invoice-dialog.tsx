'use client';

import { useEffect, useState } from 'react';
import { Button, Check, Dialog, Field, InlineNotice, Input, Textarea } from '@meritbooks/merit-ui';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';

interface SendDefaults {
  to: string | null;
  customerName: string | null;
  cc: string[];
  message: string | null;
  attachmentsAllowed: boolean;
  documents: Array<{ id: string; name: string; sizeBytes: number; mimeType: string | null }>;
  payButton: boolean;
  payReason: string | null;
  email: { configured: boolean; reason: string | null };
  templateName: string;
}

const kb = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/**
 * Send (or resend) an invoice: To, CC (remembered on the invoice), "send me a copy",
 * a message for this send, and invoice documents to attach. The PDF always goes.
 */
export function SendInvoiceDialog({
  invoiceId, invoiceNumber, open, onClose, onSent, resend,
}: {
  invoiceId: string;
  invoiceNumber: string;
  open: boolean;
  onClose: () => void;
  onSent: () => void;
  resend: boolean;
}) {
  const { data, isLoading, error } = useQuery<SendDefaults>(open ? `/api/invoices/${invoiceId}/send` : null, undefined, { scope: false });
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [copyMe, setCopyMe] = useState(false);
  const [message, setMessage] = useState('');
  const [attach, setAttach] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setTo(data.to ?? '');
    setCc(data.cc.join(', '));
    setMessage(data.message ?? '');
    setAttach([]);
    setErr(null);
  }, [data]);

  async function send() {
    setSending(true);
    setErr(null);
    const res = await api.post<{ sent: boolean; to: string; cc?: string[] }>(`/api/invoices/${invoiceId}/send`, {
      to: to.trim() || null,
      cc,
      copy_to_me: copyMe,
      message: message.trim() && message.trim() !== (data?.message ?? '').trim() ? message.trim() : null,
      attachment_ids: attach,
    });
    setSending(false);
    if (res.error) { setErr(res.error.error || 'The invoice could not be sent.'); return; }
    const copies = res.data?.cc?.length ? ` and ${res.data.cc.length} cc` : '';
    addToast('success', `${resend ? 'Resent' : 'Sent'} invoice ${invoiceNumber} to ${res.data?.to}${copies}`);
    onSent();
    onClose();
  }

  const blocked = !!data && !data.email.configured;

  return (
    <Dialog
      open={open}
      onClose={() => { if (!sending) onClose(); }}
      title={`${resend ? 'Resend' : 'Send'} invoice ${invoiceNumber}`}
      width={600}
      dismissOnScrim={!sending}
      footNote={data ? `Template: ${data.templateName}. The PDF is attached.` : undefined}
      actions={
        <>
          <Button onClick={onClose} disabled={sending}>Cancel</Button>
          <Button variant="primary" onClick={() => void send()} disabled={!data || blocked || sending || !to.trim()} aria-busy={sending || undefined}>
            {sending ? 'Sending…' : resend ? 'Resend' : 'Send'}
          </Button>
        </>
      }
    >
      {isLoading && !data ? (
        <div className="wg-loading" style={{ height: 180 }} aria-busy="true"><span className="bar-l" style={{ width: '60%' }} /></div>
      ) : error || !data ? (
        <InlineNotice tone="neg" title="Couldn't prepare the email.">{error ?? 'Close and try again.'}</InlineNotice>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {blocked && <InlineNotice tone="warn" title="Email isn't set up.">{data.email.reason}</InlineNotice>}
          {!data.payButton && (
            <InlineNotice tone="info" title="This email won't have a Pay button.">
              {data.payReason ?? 'Online payment is off for this invoice.'} Your payment instructions are included instead.
            </InlineNotice>
          )}
          <Field label="To" help={data.to ? undefined : `${data.customerName ?? 'This customer'} has no email on file. Type one to send this once.`}>
            <Input type="email" value={to} onChange={(e) => setTo(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="CC" help="Separate addresses with commas. Saved on this invoice for resends and reminders.">
            <Input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="ap@customer.com, pm@customer.com" autoComplete="off" />
          </Field>
          <Check label="Send me a copy" checked={copyMe} onChange={(e) => setCopyMe(e.target.checked)} />
          <Field label="Message" help="Shown in the email above the invoice summary.">
            <Textarea rows={3} maxLength={4000} value={message} onChange={(e) => setMessage(e.target.value)} />
          </Field>
          {data.attachmentsAllowed ? (
            data.documents.length > 0 && (
              <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="field-label">Also attach</legend>
                {data.documents.map((d) => (
                  <Check
                    key={d.id}
                    label={`${d.name} · ${kb(d.sizeBytes)}`}
                    checked={attach.includes(d.id)}
                    onChange={(e) => setAttach((a) => (e.target.checked ? [...a, d.id] : a.filter((x) => x !== d.id)))}
                  />
                ))}
              </fieldset>
            )
          ) : (
            data.documents.length > 0 && <p className="t-cap">This invoice&apos;s template doesn&apos;t send attachments. Turn it on in Invoices → Design.</p>
          )}
          {err && <InlineNotice tone="neg" title="Not sent.">{err}</InlineNotice>}
        </div>
      )}
    </Dialog>
  );
}
