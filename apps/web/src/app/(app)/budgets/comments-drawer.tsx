'use client';

/**
 * Line comments (Wave 4B, FP-21): the thread on one budget line — comments, "please justify"
 * requests from finance, resolve / reopen.
 */
import { useState } from 'react';
import { Button, Drawer, Field, InlineNotice, PanelSection, Select, Tag, Textarea, api, shortDate, toast, useQuery } from '@meritbooks/merit-ui';
import type { BudgetComment } from '@/lib/budgets/types';
import { errText } from './budget-format';
import s from './budgets.module.css';

export interface CommentsDrawerProps {
  open: boolean;
  onClose: () => void;
  locationId: string;
  versionId: string;
  departmentId: string | null;
  accountId: string | null;
  title: string;
  canRequest: boolean;
  onChanged?: () => void;
}

export function CommentsDrawer({ open, onClose, locationId, versionId, departmentId, accountId, title, canRequest, onChanged }: CommentsDrawerProps) {
  const q = useQuery<{ comments: BudgetComment[]; userId: string }>(
    open && accountId ? '/api/budgets/comments' : null,
    { location_id: locationId, version_id: versionId, department_id: departmentId ?? 'company', account_id: accountId ?? undefined },
  );
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<'COMMENT' | 'JUSTIFY_REQUEST'>('COMMENT');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const thread = (q.data?.comments ?? []).filter((c) => c.kind !== 'VARIANCE_EXPLANATION');

  const add = async () => {
    setBusy(true);
    setError(null);
    const res = await api.post<{ comment: BudgetComment }>('/api/budgets/comments', { location_id: locationId, version_id: versionId, department_id: departmentId, account_id: accountId, kind, body });
    setBusy(false);
    if (res.error) return setError(errText(res.error));
    setBody('');
    toast(kind === 'JUSTIFY_REQUEST' ? 'Asked for a justification' : 'Comment added');
    await q.refetch();
    onChanged?.();
  };

  const act = async (id: string, action: 'resolve' | 'reopen') => {
    const res = await api.patch<{ comment: BudgetComment }>('/api/budgets/comments', { comment_id: id, action });
    if (res.error) return toast.error(errText(res.error));
    await q.refetch();
    onChanged?.();
  };

  return (
    <Drawer open={open} onClose={onClose} width={420} eyebrow="Comments" title={title}
      foot={<><Button variant="quiet" onClick={onClose}>Close</Button><Button variant="primary" onClick={add} disabled={busy || body.trim().length === 0}>{busy ? 'Posting…' : kind === 'JUSTIFY_REQUEST' ? 'Ask for justification' : 'Post comment'}</Button></>}
    >
      {error && <InlineNotice tone="neg" className={s.notice}>{error}</InlineNotice>}
      <PanelSection title="Thread" meta={q.isLoading ? 'Loading…' : `${thread.length}`}>
        {q.error && <InlineNotice tone="neg">{q.error}</InlineNotice>}
        {!q.isLoading && thread.length === 0 && <p className={s.muted}>No comments on this line yet.</p>}
        <ul className={s.varList}>
          {thread.map((c) => (
            <li key={c.id} className={s.varItem}>
              <div className={s.varHead}>
                <strong>{c.authorName ?? (c.authorUserId === q.data?.userId ? 'You' : 'Someone')}</strong>
                <span className={s.row}>
                  {c.kind === 'JUSTIFY_REQUEST' && <Tag tone="warn">Justify</Tag>}
                  {c.status === 'RESOLVED' && <Tag tone="pos">Resolved</Tag>}
                  <span className={s.muted}>{shortDate(c.createdAt)}</span>
                </span>
              </div>
              <p style={{ margin: '4px 0' }}>{c.body}</p>
              <Button variant="quiet" onClick={() => act(c.id, c.status === 'RESOLVED' ? 'reopen' : 'resolve')}>{c.status === 'RESOLVED' ? 'Reopen' : 'Resolve'}</Button>
            </li>
          ))}
        </ul>
      </PanelSection>
      <PanelSection title="Add">
        {canRequest && (
          <Field label="Type">
            <Select value={kind} onChange={(e) => setKind(e.target.value as 'COMMENT' | 'JUSTIFY_REQUEST')}>
              <option value="COMMENT">Comment</option>
              <option value="JUSTIFY_REQUEST">Ask the owner to justify this line</option>
            </Select>
          </Field>
        )}
        <Field label="Comment">
          <Textarea rows={3} value={body} maxLength={4000} onChange={(e) => setBody(e.target.value)} />
        </Field>
      </PanelSection>
    </Drawer>
  );
}
