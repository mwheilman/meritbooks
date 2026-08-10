import type { BasisOverlay } from './use-basis-overlay';

/**
 * Apply a reporting-basis overlay to the RAW report payload an export re-fetches, so the
 * PDF / XLSX / CSV carry the SAME adjusted figures the on-screen statement shows (and the
 * export's basis label is therefore accurate). Pure transforms over the exact JSON the
 * income-statement / balance-sheet / trial-balance endpoints return. GAAP (overlay disabled)
 * is a pass-through — the export is byte-for-byte today's output.
 */

function delta(overlay: BasisOverlay, accountId: string | undefined): number {
  if (!accountId) return 0;
  return overlay.byAccount.get(accountId)?.naturalCents ?? 0;
}

// ── P&L ──────────────────────────────────────────────────────────────────────
interface EPnlAcct { accountId?: string; accountNumber: string; accountName: string; amountCents: number }
interface EPnlGroup { name: string; accounts: EPnlAcct[]; totalCents: number }
interface EPnlSection { type: string; label: string; groups: EPnlGroup[]; totalCents: number }
interface EPnlSummary {
  revenueCents: number; cogsCents: number; grossProfitCents: number; opexCents: number;
  ebitdaCents: number; otherCents: number; netIncomeCents: number; grossMarginPct: number; netMarginPct: number;
}
interface EPnlData { sections: EPnlSection[]; summary: EPnlSummary; filters?: unknown }

function applyPnl(data: EPnlData, overlay: BasisOverlay): EPnlData {
  let dRev = 0, dCogs = 0, dOpex = 0, dOther = 0;
  const sections = data.sections.map((sec) => {
    let secDelta = 0;
    const groups = sec.groups.map((g) => {
      let gTotal = 0;
      const accounts = g.accounts.map((a) => {
        const d = delta(overlay, a.accountId);
        const amountCents = a.amountCents + d;
        gTotal += amountCents; secDelta += d;
        return { ...a, amountCents };
      });
      return { ...g, accounts, totalCents: gTotal };
    });
    if (sec.type === 'REVENUE') dRev += secDelta;
    else if (sec.type === 'COGS') dCogs += secDelta;
    else if (sec.type === 'OPEX') dOpex += secDelta;
    else if (sec.type === 'OTHER') dOther += secDelta;
    return { ...sec, groups, totalCents: sec.totalCents + secDelta };
  });
  const s = data.summary;
  const revenueCents = s.revenueCents + dRev;
  const rb = Math.abs(revenueCents) || 1;
  const grossProfitCents = s.grossProfitCents + dRev - dCogs;
  const netIncomeCents = s.netIncomeCents + dRev - dCogs - dOpex - dOther;
  const summary: EPnlSummary = {
    ...s,
    revenueCents,
    cogsCents: s.cogsCents + dCogs,
    opexCents: s.opexCents + dOpex,
    otherCents: s.otherCents + dOther,
    grossProfitCents,
    ebitdaCents: s.ebitdaCents + dRev - dCogs - dOpex,
    netIncomeCents,
    grossMarginPct: Math.round((grossProfitCents / rb) * 10000) / 100,
    netMarginPct: Math.round((netIncomeCents / rb) * 10000) / 100,
  };
  return { ...data, sections, summary };
}

// ── Balance Sheet ─────────────────────────────────────────────────────────────
interface EBsAcct { accountId?: string; accountNumber: string; accountName: string; balanceCents: number }
interface EBsGroup { name: string; accounts: EBsAcct[]; totalCents: number }
interface EBsSubType { name: string; groups: EBsGroup[]; totalCents: number }
interface EBsSection { type: string; label: string; subTypes: EBsSubType[]; totalCents: number }
interface EBsSummary {
  totalAssetsCents: number; totalLiabilitiesCents: number; totalEquityCents: number;
  liabilitiesPlusEquityCents: number; isBalanced: boolean; varianceCents: number;
}
interface EBsData { sections: EBsSection[]; summary: EBsSummary; filters?: unknown }

function applyBs(data: EBsData, overlay: BasisOverlay): EBsData {
  const deltaByType: Record<string, number> = {};
  const sections = data.sections.map((sec) => {
    let secDelta = 0;
    const subTypes = sec.subTypes.map((st) => {
      const groups = st.groups.map((g) => {
        let gTotal = 0;
        const accounts = g.accounts.map((a) => {
          const d = delta(overlay, a.accountId);
          gTotal += a.balanceCents + d; secDelta += d;
          return { ...a, balanceCents: a.balanceCents + d };
        });
        return { ...g, accounts, totalCents: gTotal };
      });
      return { ...st, groups, totalCents: groups.reduce((s, g) => s + g.totalCents, 0) };
    });
    deltaByType[sec.type] = (deltaByType[sec.type] ?? 0) + secDelta;
    return { ...sec, subTypes, totalCents: sec.totalCents + secDelta };
  });
  const s = data.summary;
  const totalAssetsCents = s.totalAssetsCents + (deltaByType.ASSET ?? 0);
  const totalLiabilitiesCents = s.totalLiabilitiesCents + (deltaByType.LIABILITY ?? 0);
  const totalEquityCents = s.totalEquityCents + (deltaByType.EQUITY ?? 0);
  const liabilitiesPlusEquityCents = totalLiabilitiesCents + totalEquityCents;
  const varianceCents = totalAssetsCents - liabilitiesPlusEquityCents;
  const summary: EBsSummary = {
    ...s, totalAssetsCents, totalLiabilitiesCents, totalEquityCents,
    liabilitiesPlusEquityCents, isBalanced: varianceCents === 0, varianceCents,
  };
  return { ...data, sections, summary };
}

// ── Trial Balance ─────────────────────────────────────────────────────────────
interface ETbRow { account_id?: string; net_balance: number | string; [k: string]: unknown }
interface ETbData { data: ETbRow[] }

function applyTb(payload: ETbData, overlay: BasisOverlay): ETbData {
  const rows = (payload.data ?? []).map((r) => ({
    ...r,
    net_balance: Number(r.net_balance ?? 0) + delta(overlay, r.account_id),
  }));
  return { ...payload, data: rows };
}

/**
 * Apply the overlay to the fetched payload for the statements that support it. Non-statement
 * reports and GAAP (disabled overlay) are returned unchanged.
 */
export function applyOverlayToExportPayload(
  reportKey: string,
  data: unknown,
  overlay: BasisOverlay,
): unknown {
  if (!overlay.enabled || !data) return data;
  if (reportKey === 'pnl' || reportKey === 'pnl_dept' || reportKey === 'pnl_class') {
    return applyPnl(data as EPnlData, overlay);
  }
  if (reportKey === 'bs') return applyBs(data as EBsData, overlay);
  if (reportKey === 'tb') return applyTb(data as ETbData, overlay);
  return data;
}
