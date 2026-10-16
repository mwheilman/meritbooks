export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { clerkClient, currentUser } from '@clerk/nextjs/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAuthedContext } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';
import { deriveOrgSlug, isValidTimezone, splitFullName } from '@/lib/onboarding/org-setup';

/**
 * /api/setup — ORGANIZATION creation only ("one front door", FPB-onboarding B5/B7).
 *
 * Companies, chart of accounts, opening balances, bank and team all live in the ONE
 * onboarding wizard (/onboarding). Departments and the internal-charge method are
 * deferred to Settings. This route only answers "does the CALLER have an organization"
 * and, if not, creates one for them.
 *
 * ORG RESOLUTION (B7): the caller's org comes from requireAuthedContext — the same
 * claim-first resolveTenantOrgId every API route uses. There is NO "first org in the
 * database" lookup anywhere in this file, so a caller can never be handed (or modify)
 * another tenant's organization.
 *
 * SELF-SERVE CREATION: the tenant is resolved from the Clerk organization claim, so a
 * Books org is only reachable when it is BOUND to a Clerk org (core.organizations.
 * clerk_org_id, migration 061/087). Creating an org therefore:
 *   1. refuses if the caller already belongs to any Clerk org (one self-serve org per
 *      user; an existing member is told to RE-ACTIVATE their org instead),
 *   2. creates a Clerk organization with the caller as its admin,
 *   3. inserts the Books org bound to it (clerk_org_id) on the service-role client,
 *   4. seats the caller as company_admin (core.employees; /api/me then provisions the
 *      core.users + core.memberships spine on the next request),
 *   compensating (deleting) what it created if a later step fails. The client then
 *   calls Clerk `setActive({ organization })` so the session carries the org claim.
 */

// ─── GET: the caller's setup state ───────────────────────────────────────────

interface ActivatableOrg { clerkOrgId: string; orgId: string; name: string }

/** The caller's Clerk org memberships that are bound to a Books tenant. */
async function boundMemberships(
  userId: string,
  admin: SupabaseClient,
): Promise<{ bound: ActivatableOrg[]; clerkMembershipCount: number }> {
  const client = await clerkClient();
  const list = await client.users.getOrganizationMembershipList({ userId, limit: 20 });
  const clerkIds = list.data.map((m) => m.organization.id).filter((id): id is string => typeof id === 'string');
  if (clerkIds.length === 0) return { bound: [], clerkMembershipCount: 0 };

  const { data } = await admin
    .schema('core')
    .from('organizations')
    .select('id, name, clerk_org_id')
    .in('clerk_org_id', clerkIds);
  const rows = (data ?? []) as Array<{ id: string; name: string | null; clerk_org_id: string | null }>;
  return {
    bound: rows
      .filter((r): r is { id: string; name: string | null; clerk_org_id: string } => typeof r.clerk_org_id === 'string')
      .map((r) => ({ clerkOrgId: r.clerk_org_id, orgId: r.id, name: r.name ?? 'Your organization' })),
    clerkMembershipCount: clerkIds.length,
  };
}

export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;

  if (orgId) {
    const { data: org, error } = await supabase
      .schema('core')
      .from('organizations')
      .select('id, name, setup_complete')
      .eq('id', orgId)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
    if (org) {
      return NextResponse.json({
        hasOrg: true,
        orgId: org.id,
        orgName: org.name,
        // Kept for older readers: org provisioned. Onboarding progress is per company
        // and lives in /api/onboarding/status.
        setupComplete: true,
        onboardingFinished: org.setup_complete === true,
        next: '/onboarding',
      });
    }
  }

  // No resolvable org. Is the caller a member of an org whose session just isn't
  // active? Then /setup offers to re-activate it rather than create a duplicate.
  let activatable: ActivatableOrg[] = [];
  try {
    activatable = (await boundMemberships(userId, createAdminSupabase())).bound;
  } catch (e) {
    console.error('[setup] membership lookup failed:', e instanceof Error ? e.message : e);
  }
  return NextResponse.json({ hasOrg: false, setupComplete: false, step: 'organization', activatable });
}

// ─── POST: create the caller's organization ──────────────────────────────────

const orgSchema = z.object({
  step: z.literal('organization'),
  name: z.string().trim().min(1, 'Organization name is required').max(200),
  your_name: z.string().trim().max(200).optional(),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers, and single dashes')
    .optional(),
  timezone: z.string().trim().max(64).optional(),
});

export async function POST(request: NextRequest) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  if (raw && typeof raw === 'object' && (raw as { step?: unknown }).step !== 'organization') {
    return NextResponse.json(
      {
        error: 'Companies, chart of accounts, team and opening balances are set up in onboarding now.',
        code: 'STEP_MOVED',
        next: '/onboarding',
      },
      { status: 410 },
    );
  }
  const parsed = orgSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      },
      { status: 422 },
    );
  }
  const body = parsed.data;

  // ── The caller already has an org → hand back THEIR org (never another tenant's).
  if (orgId) {
    const { data: org } = await supabase
      .schema('core').from('organizations').select('id, name').eq('id', orgId).maybeSingle();
    if (org) {
      return NextResponse.json({ success: true, orgId: org.id, orgName: org.name, alreadyExisted: true, next: '/onboarding' });
    }
    // Claim resolved but the row isn't visible → fail closed rather than create a twin.
    return NextResponse.json(
      { error: 'Your organization could not be loaded. Please sign out and back in.', code: 'ORG_NOT_VISIBLE' },
      { status: 409 },
    );
  }

  const admin = createAdminSupabase();

  // ── Existing member with no active org in this session → re-activate, don't create.
  let membership: { bound: ActivatableOrg[]; clerkMembershipCount: number };
  try {
    membership = await boundMemberships(userId, admin);
  } catch (e) {
    console.error('[setup] membership lookup failed:', e instanceof Error ? e.message : e);
    return NextResponse.json(
      { error: 'We could not verify your account right now. Please try again in a moment.', code: 'IDENTITY_UNAVAILABLE' },
      { status: 503 },
    );
  }
  if (membership.bound.length > 0) {
    const first = membership.bound[0];
    return NextResponse.json({
      success: true,
      orgId: first.orgId,
      orgName: first.name,
      clerkOrgId: first.clerkOrgId,
      activate: true,
      alreadyExisted: true,
      next: '/onboarding',
    });
  }
  if (membership.clerkMembershipCount > 0) {
    // A Clerk org exists for this user but isn't bound to any Books tenant. Binding
    // it is an operator decision (could be a half-provisioned tenant) — never guess.
    return NextResponse.json(
      {
        error: 'Your sign-in belongs to an organization that is not connected to MeritBooks yet. Contact support to finish connecting it.',
        code: 'CLERK_ORG_UNBOUND',
      },
      { status: 409 },
    );
  }

  // ── One self-serve org per user (security): a caller who already holds an ACTIVE
  // seat in any Books org (e.g. they deleted/left the Clerk org, orphaning the Books
  // tenant) must not be able to mint tenants in a loop. Route them to support.
  {
    const { count: seatCount, error: seatErr } = await admin
      .schema('core')
      .from('employees')
      .select('id', { count: 'exact', head: true })
      .eq('clerk_user_id', userId)
      .eq('is_active', true);
    if (seatErr) {
      console.error('[setup] seat lookup failed:', seatErr.message);
      return NextResponse.json(
        { error: 'We could not verify your account right now. Please try again in a moment.', code: 'IDENTITY_UNAVAILABLE' },
        { status: 503 },
      );
    }
    if ((seatCount ?? 0) > 0) {
      return NextResponse.json(
        {
          error: 'Your sign-in already has a seat in a MeritBooks organization. Contact support to reconnect it.',
          code: 'SEAT_EXISTS',
        },
        { status: 409 },
      );
    }
  }

  // ── Brand-new user → create the Clerk org, the bound Books org, and the founder seat.
  const clerkUser = await currentUser().catch(() => null);
  const email =
    clerkUser?.emailAddresses?.find((e) => e.id === clerkUser.primaryEmailAddressId)?.emailAddress ??
    clerkUser?.emailAddresses?.[0]?.emailAddress ??
    null;
  const fallbackName = [clerkUser?.firstName, clerkUser?.lastName].filter(Boolean).join(' ');
  const { firstName, lastName } = splitFullName(body.your_name || fallbackName);
  const timezone = body.timezone && isValidTimezone(body.timezone) ? body.timezone : 'America/Chicago';

  const client = await clerkClient();
  let clerkOrgId: string;
  try {
    const clerkOrg = await client.organizations.createOrganization({ name: body.name, createdBy: userId });
    clerkOrgId = clerkOrg.id;
  } catch (e) {
    console.error('[setup] Clerk createOrganization failed:', e instanceof Error ? e.message : e);
    return NextResponse.json(
      {
        error: 'We could not create your organization. If this keeps happening, organizations may not be enabled for this sign-in instance.',
        code: 'IDENTITY_ORG_CREATE_FAILED',
      },
      { status: 502 },
    );
  }

  const undoClerkOrg = async () => {
    await client.organizations.deleteOrganization(clerkOrgId).catch((err: unknown) => {
      console.error('[setup] compensating Clerk org delete failed:', err instanceof Error ? err.message : err);
    });
  };

  // ── Concurrency guard (security): two simultaneous POSTs both pass the "no
  // membership" check above and would each mint a tenant. Re-read the caller's Clerk
  // memberships now that ours exists; if another org appeared, a deterministic
  // tie-break (earliest createdAt, then id) picks ONE survivor — every other racer
  // deletes its own Clerk org and backs off, so a double-click never yields two orgs.
  try {
    const after = await client.users.getOrganizationMembershipList({ userId, limit: 20 });
    const orgs = after.data.map((m) => ({ id: m.organization.id, createdAt: m.organization.createdAt }));
    if (orgs.length > 1) {
      const winner = [...orgs].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
      if (winner.id !== clerkOrgId) {
        await undoClerkOrg();
        return NextResponse.json(
          { error: 'Your organization is already being set up. Refresh the page in a moment.', code: 'SETUP_IN_PROGRESS' },
          { status: 409 },
        );
      }
    }
  } catch (e) {
    // Can't prove we're the only racer → fail closed (undo) rather than risk a twin.
    console.error('[setup] post-create membership re-check failed:', e instanceof Error ? e.message : e);
    await undoClerkOrg();
    return NextResponse.json(
      { error: 'We could not verify your account right now. Please try again in a moment.', code: 'IDENTITY_UNAVAILABLE' },
      { status: 503 },
    );
  }

  // Insert the Books org (slug is unique; retry with a suffix on collision).
  let newOrgId: string | null = null;
  let lastError = 'Failed to create organization';
  for (let attempt = 0; attempt < 4 && !newOrgId; attempt++) {
    const slug = deriveOrgSlug(body.slug || body.name, attempt === 0 ? null : Math.random().toString(36).slice(2, 6));
    const { data, error } = await admin
      .schema('core')
      .from('organizations')
      .insert({
        name: body.name,
        slug,
        primary_contact_name: [firstName, lastName].filter(Boolean).join(' ') || null,
        primary_contact_email: email,
        timezone,
        setup_complete: false,
        clerk_org_id: clerkOrgId,
      })
      .select('id')
      .single();
    if (!error && data) {
      newOrgId = data.id as string;
    } else {
      lastError = error?.message ?? lastError;
      if (error?.code !== '23505') break; // only a unique collision is worth retrying
    }
  }
  if (!newOrgId) {
    await undoClerkOrg();
    console.error('[setup] org insert failed:', lastError);
    return NextResponse.json({ error: 'Failed to create organization', code: 'INSERT_ERROR' }, { status: 500 });
  }

  // Seat the founder as company_admin (service-role: the caller has no org claim yet,
  // so RLS cannot see the new org until the session is re-activated).
  const { error: empErr } = await admin
    .schema('core')
    .from('employees')
    .insert({
      org_id: newOrgId,
      clerk_user_id: userId,
      first_name: firstName || 'Owner',
      last_name: lastName || '',
      email: email ?? '',
      role: 'company_admin',
      is_active: true,
    });
  if (empErr) {
    console.error('[setup] founder seat failed:', empErr.message);
    await admin.schema('core').from('organizations').delete().eq('id', newOrgId);
    await undoClerkOrg();
    return NextResponse.json({ error: 'Failed to set you up as the owner', code: 'INSERT_ERROR' }, { status: 500 });
  }

  return NextResponse.json(
    { success: true, orgId: newOrgId, orgName: body.name, clerkOrgId, activate: true, next: '/onboarding' },
    { status: 201 },
  );
}
