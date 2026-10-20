import { logHumanAction } from '@/lib/trust/action-log';
import type { DealerCtx } from './context';

/** Best-effort human attribution in core.action_log (GL author columns stay null). */
export async function audit(
  d: DealerCtx,
  action: string,
  subjectTable: string,
  subjectId: string | null,
  summary: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await logHumanAction(d.admin, d.userId, d.orgId, {
      action: `dealer.${action}`,
      subjectTable,
      subjectId,
      summary,
      locationId: d.locationId,
      metadata,
    });
  } catch {
    /* the subledger row carries the actor; the trail is best-effort */
  }
}
