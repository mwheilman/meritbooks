export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { matchParties } from '@/lib/parties/match';
import { userRateLimited } from '@/lib/security/user-limits';

/**
 * POST /api/parties/match — "Already in Merit": ranked existing customers / vendors / contacts for
 * a record about to be created, from the suite matcher (core.match_parties, Projects 1111). Read
 * only. Runs AS THE CALLER (their RLS + the matcher's own scoping and masking). Works for every
 * org — with or without Merit Projects.
 *
 * Gate: customers:view (customer / contact) or vendors:view (vendor) — the screens that create them.
 * Candidates outside the caller's Books client scope are dropped (lib/parties/match.ts, M3), and
 * the lookup is rate-limited per user (it is an enumeration surface: name / email / phone probes).
 */
const bodySchema = z.object({
  kind: z.enum(['customer', 'vendor', 'contact']),
  name: z.string().trim().max(300).default(''),
  email: z.string().trim().max(320).nullable().optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  tax_id: z.string().trim().max(50).nullable().optional(),
  limit: z.number().int().min(1).max(10).optional(),
});

export const POST = apiHandler(bodySchema, async (b, { userId, orgId, supabase }) => {
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await requirePermission(userId, b.kind === 'vendor' ? 'vendors' : 'customers', 'view', { route: '/api/parties/match' });
  if (!guard.ok) return guard.response;
  const limited = userRateLimited('partiesMatch', userId);
  if (limited) return limited;

  const r = await matchParties(supabase, {
    kind: b.kind, name: b.name ?? '', email: b.email ?? null, phone: b.phone ?? null, address: b.address ?? null, taxId: b.tax_id ?? null,
    limit: b.limit ?? 5,
  });
  return NextResponse.json({ available: r.available, matches: r.matches });
});
