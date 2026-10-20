/**
 * Loaders for R5 Warranty receivable aging and R6 Incentive receivable aging.
 */

import type { IncentiveStatus, ProgramType, WarrantyStatus } from '@/lib/dealer/types';
import type { DealerReport } from './catalog';
import { buildIncentiveAging, buildWarrantyAging } from './build-receivables';
import { all, allIn, ids, num, str, vendorNames, type ReportCtx } from './load-shared';

export async function loadWarrantyAging(d: ReportCtx, asOf: string, entityLabel: string): Promise<DealerReport> {
  const [claims, events] = await Promise.all([
    all('Warranty claims', () =>
      d.db
        .from('warranty_claims')
        .select('id, oem_vendor_id, oem_claim_number, dealer_claim_ref, serial_number, status, claimed_cents, settled_cents, written_off_cents, submitted_date, created_at')
        .eq('org_id', d.orgId)
        .eq('location_id', d.locationId)
        .neq('status', 'VOID'),
    ),
    all('Warranty rejections', () =>
      d.db.from('dealer_claim_events').select('id, warranty_claim_id').eq('org_id', d.orgId).eq('location_id', d.locationId).eq('claim_kind', 'WARRANTY').eq('event_type', 'REJECTED').lte('event_date', asOf),
    ),
  ]);
  // Point-in-time: claims created after the as-of date are not yet receivables.
  const asOfClaims = claims.filter((c) => !c.created_at || String(c.created_at).slice(0, 10) <= asOf);
  const oemNames = await vendorNames(d, ids(asOfClaims, 'oem_vendor_id'));
  return buildWarrantyAging({
    asOf,
    entityLabel,
    oemNames,
    rejectedClaimIds: new Set(ids(events, 'warranty_claim_id')),
    claims: asOfClaims.map((c) => ({
      id: c.id as string,
      oem_vendor_id: c.oem_vendor_id as string,
      oem_claim_number: str(c.oem_claim_number),
      dealer_claim_ref: str(c.dealer_claim_ref),
      serial_number: str(c.serial_number),
      status: c.status as WarrantyStatus,
      claimed_cents: num(c.claimed_cents),
      settled_cents: num(c.settled_cents),
      written_off_cents: num(c.written_off_cents),
      submitted_date: str(c.submitted_date),
    })),
  });
}

export async function loadIncentiveAging(d: ReportCtx, asOf: string, entityLabel: string): Promise<DealerReport> {
  const claims = await all('Incentive claims', () =>
    d.db
      .from('oem_incentive_claims')
      .select('id, program_id, status, claim_reference, earned_date, submitted_date, claim_deadline, accrued_cents, claimed_cents, settled_cents, written_off_cents')
      .eq('org_id', d.orgId)
      .eq('location_id', d.locationId)
      .in('status', ['ACCRUED', 'SUBMITTED', 'PARTIAL', 'REJECTED'])
      .lte('earned_date', asOf),
  );
  const programs = await allIn('Incentive programs', ids(claims, 'program_id'), (chunk) =>
    d.db.from('oem_programs').select('id, name, oem_vendor_id, program_type').eq('org_id', d.orgId).in('id', chunk),
  );
  const oemNames = await vendorNames(d, ids(programs, 'oem_vendor_id'));
  return buildIncentiveAging({
    asOf,
    entityLabel,
    oemNames,
    programs: new Map(programs.map((p) => [p.id as string, { name: String(p.name ?? 'Program'), oem_vendor_id: p.oem_vendor_id as string, program_type: p.program_type as ProgramType }])),
    claims: claims.map((c) => ({
      id: c.id as string,
      program_id: c.program_id as string,
      status: c.status as IncentiveStatus,
      claim_reference: str(c.claim_reference),
      earned_date: String(c.earned_date),
      submitted_date: str(c.submitted_date),
      claim_deadline: str(c.claim_deadline),
      accrued_cents: num(c.accrued_cents),
      claimed_cents: num(c.claimed_cents),
      settled_cents: num(c.settled_cents),
      written_off_cents: num(c.written_off_cents),
    })),
  });
}
