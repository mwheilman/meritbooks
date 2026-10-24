'use client';

import { useCallback, useState } from 'react';
import { api, toast } from '@meritbooks/merit-ui';
import { checkMove, type MoveReasonKind } from '@/lib/crm/stages';
import type { StageRow } from '@/lib/crm/types';

export interface MovableLead {
  id: string;
  title: string;
  pipelineId: string;
  stageId: string;
  customerId: string | null;
  /** The lead's contact id is not in the view; "has a person" is enough for the won rule. */
  hasContact: boolean;
  convertedJobId: string | null;
  convertedEstimateId: string | null;
}

export interface PendingMove {
  lead: MovableLead;
  to: StageRow;
  reason: MoveReasonKind;
}

/**
 * The one way a lead changes stage in the UI: check the move (lib/crm/stages), ask for a reason
 * when it needs one, then crm.move_lead. `onMoved` lets the caller update optimistically and
 * roll back on failure.
 */
export function useMoveLead(stages: ReadonlyArray<StageRow>, onMoved: (leadId: string, stageId: string) => void, onSettled?: () => void) {
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [busy, setBusy] = useState(false);

  const send = useCallback(async (lead: MovableLead, to: StageRow, reason: string | null) => {
    const from = lead.stageId;
    onMoved(lead.id, to.id);
    setBusy(true);
    const r = await api.post<{ ok: true }>(`/api/crm/leads/${lead.id}/move`, { stageId: to.id, reason });
    setBusy(false);
    if (r.error) {
      onMoved(lead.id, from);
      toast.error(r.error.error);
      return false;
    }
    setPending(null);
    onSettled?.();
    toast(to.kind === 'won' ? `Marked ${lead.title} won` : to.kind === 'lost' ? `Marked ${lead.title} lost` : `Moved ${lead.title} to ${to.name}`);
    return true;
  }, [onMoved, onSettled]);

  const request = useCallback((lead: MovableLead, toId: string) => {
    const to = stages.find((s) => s.id === toId);
    if (!to) return;
    const from = stages.find((s) => s.id === lead.stageId) ?? null;
    const check = checkMove(
      { pipeline_id: lead.pipelineId, stage_id: lead.stageId, customer_id: lead.customerId, contact_id: lead.hasContact ? 'yes' : null, converted_job_id: lead.convertedJobId, converted_estimate_id: lead.convertedEstimateId },
      from,
      to,
    );
    if (!check.ok) {
      if (from?.id !== to.id) toast.error(check.message);
      return;
    }
    if (check.reason) setPending({ lead, to, reason: check.reason });
    else void send(lead, to, null);
  }, [stages, send]);

  return {
    request,
    pending,
    busy,
    cancel: () => setPending(null),
    confirm: (reason: string) => (pending ? void send(pending.lead, pending.to, reason) : undefined),
  };
}
