export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { assertWriteScope, isWriteScopeError } from '@/lib/db/scoped-writer';
import { getAlias, toAliasView, updateAlias } from '@/lib/email/inbound-aliases';
import { readInboundConfig } from '@/lib/email/inbound-config';
import { SENDER_RULE_LABEL } from '@/lib/email/inbound-rules';
import { logHumanAction } from '@/lib/trust/action-log';
import { inboundAliasPatch } from '@/lib/validations/inbound-email';

/**
 * PATCH /api/inbound-email/aliases  { alias_id, is_active?, sender_rule?, allowed_domains?,
 *                                     allowed_senders?, allow_sender?, dismiss_forwarding? }
 *
 * settings_system:edit. core.inbound_aliases is SELECT-only for members (migration 183):
 * the alias is first read as the caller's org, its company asserted in the caller's
 * client scope, then written through the service role (org pinned). Audited.
 */
export const PATCH = apiHandler(inboundAliasPatch, async (b, { userId, supabase }) => {
  const guard = await requirePermission(userId, 'settings_system', 'edit', { route: '/api/inbound-email/aliases' });
  if (!guard.ok) return guard.response;
  const orgId = guard.orgId;
  const admin = createAdminSupabase();

  const current = await getAlias(admin, orgId, b.alias_id);
  if (!current) return NextResponse.json({ error: 'Address not found', code: 'NOT_FOUND' }, { status: 404 });
  try {
    await assertWriteScope(supabase, orgId, [current.location_id]);
  } catch (e) {
    if (isWriteScopeError(e)) return NextResponse.json({ error: e.message, code: 'FORBIDDEN' }, { status: 403 });
    throw e;
  }

  const ruleAfter = b.sender_rule ?? current.sender_rule;
  const domainsAfter = b.allowed_domains ?? current.allowed_domains;
  const sendersAfter = b.allowed_senders ?? current.allowed_senders;
  if (ruleAfter === 'listed_domains' && domainsAfter.length === 0 && sendersAfter.length === 0 && !b.allow_sender) {
    return NextResponse.json(
      { error: 'Add at least one domain or sender before limiting this address to a list — otherwise only your team could send to it.', code: 'VALIDATION_ERROR' },
      { status: 422 },
    );
  }

  const updated = await updateAlias(admin, orgId, b.alias_id, {
    is_active: b.is_active,
    sender_rule: b.sender_rule,
    allowed_domains: b.allowed_domains,
    allowed_senders: b.allowed_senders,
    allow_sender: b.allow_sender,
    dismiss_forwarding: b.dismiss_forwarding,
  }, userId);
  if (!updated) return NextResponse.json({ error: 'Address not found', code: 'NOT_FOUND' }, { status: 404 });

  const changes: string[] = [];
  if (b.is_active !== undefined && b.is_active !== current.is_active) changes.push(b.is_active ? 'switched on' : 'switched off');
  if (b.sender_rule && b.sender_rule !== current.sender_rule) changes.push(`who may send: ${SENDER_RULE_LABEL[b.sender_rule]}`);
  if (b.allowed_domains) changes.push(`allowed domains: ${b.allowed_domains.join(', ') || 'none'}`);
  if (b.allowed_senders) changes.push(`allowed senders: ${b.allowed_senders.length}`);
  if (b.allow_sender) changes.push(`allowed sender ${b.allow_sender}`);
  if (b.dismiss_forwarding) changes.push('cleared the forwarding confirmation');
  await logHumanAction(admin, userId, orgId, {
    locationId: current.location_id,
    action: 'inbound_email.alias.update',
    subjectTable: 'inbound_aliases',
    subjectId: current.id,
    summary: `Email inbox ${current.local_part}: ${changes.join('; ') || 'updated'}`,
    metadata: { before: { is_active: current.is_active, sender_rule: current.sender_rule }, patch: b },
  });

  const { data: loc } = await admin.schema('core').from('locations').select('name, is_active').eq('id', updated.location_id).maybeSingle();
  return NextResponse.json({ alias: toAliasView(updated, (loc as { name: string; is_active: boolean } | null) ?? undefined, readInboundConfig()) });
});
