/**
 * SandboxOriginationProvider — the deterministic, no-network money-out rail.
 *
 * Purpose (mirrors MockPayrollEngine):
 *  - Makes the whole origination workflow (create → submit → refresh → SETTLED /
 *    RETURNED) exercisable end-to-end with ZERO provider access.
 *  - Is the dev / no-provider default so the origination lane never depends on a
 *    real rail being connected.
 *
 * It SIMULATES a rail: submitBatch hands back a deterministic provider batch ref and
 * marks every line SUBMITTED; getStatus reports SETTLED unless a `simulate` directive
 * asks for a RETURN (with an ACH return code) or an outright FAILURE — which is how
 * the return path is tested. Nothing here moves money, touches the GL, or hits a
 * network. A real ACH/wire adapter replaces THIS class behind the same interface.
 */

import type {
  OriginationProvider,
  OriginationRail,
  ProviderItemResult,
  StatusQuery,
  StatusResult,
  SubmitBatchInput,
  SubmitBatchResult,
} from './provider';

/** Default ACH return code the sandbox stamps when a simulated return omits one. */
export const SANDBOX_DEFAULT_RETURN_CODE = 'R01'; // "Insufficient Funds"

export class SandboxOriginationProvider implements OriginationProvider {
  readonly name = 'SANDBOX';
  readonly rails: readonly OriginationRail[] = ['ACH', 'WIRE'];

  isConfigured(): boolean {
    return true; // the sandbox needs no credentials — it is always available.
  }

  async submitBatch(input: SubmitBatchInput): Promise<SubmitBatchResult> {
    // Deterministic ref derived from our batch id, so re-submitting the same batch
    // yields a stable provider ref (idempotent-friendly).
    const providerBatchRef = `sbx_batch_${input.batchId}`;
    const items: ProviderItemResult[] = input.lines.map((l) => ({
      itemId: l.itemId,
      status: 'SUBMITTED',
      providerItemRef: `sbx_item_${l.itemId}`,
    }));
    return {
      providerBatchRef,
      status: 'SUBMITTED',
      items,
      trace: {
        adapter: 'SANDBOX',
        action: 'submitBatch',
        rail: input.rail,
        effectiveDate: input.effectiveDate,
        lineCount: input.lines.length,
        totalCents: input.lines.reduce((s, l) => s + l.amountCents, 0),
        note: 'SANDBOX — no live rail; no money moved.',
      },
    };
  }

  async getStatus(query: StatusQuery): Promise<StatusResult> {
    const returnsByItem = new Map<string, string>();
    for (const r of query.simulate?.returns ?? []) {
      returnsByItem.set(r.itemId, r.returnCode || SANDBOX_DEFAULT_RETURN_CODE);
    }

    // A forced batch failure marks every line FAILED and the batch FAILED.
    if (query.simulate?.fail) {
      const items: ProviderItemResult[] = query.lines.map((l) => ({
        itemId: l.itemId,
        status: 'FAILED',
      }));
      return {
        status: 'FAILED',
        items,
        trace: { adapter: 'SANDBOX', action: 'getStatus', outcome: 'FAILED', simulated: true },
      };
    }

    const items: ProviderItemResult[] = query.lines.map((l) => {
      const returnCode = returnsByItem.get(l.itemId);
      if (returnCode) {
        return { itemId: l.itemId, status: 'RETURNED', returnCode };
      }
      return { itemId: l.itemId, status: 'SETTLED' };
    });

    const anyReturned = items.some((i) => i.status === 'RETURNED');
    return {
      status: anyReturned ? 'RETURNED' : 'SETTLED',
      items,
      trace: {
        adapter: 'SANDBOX',
        action: 'getStatus',
        outcome: anyReturned ? 'RETURNED' : 'SETTLED',
        returnedCount: items.filter((i) => i.status === 'RETURNED').length,
        simulated: !!query.simulate,
      },
    };
  }
}
