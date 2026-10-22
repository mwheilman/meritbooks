/**
 * "Preview as" (spec §4) — owners only (REAL grant projects.settings:configure).
 *   POST   { persona }  → sets the mp_preview cookie; → { ok, preview, access: AccessJson }
 *   DELETE              → clears it (always allowed: leaving a preview can only widen back to
 *                         the caller's real grants, which they already hold).
 * The server intersects the real grants with the persona template's; RLS still runs as the
 * real user, so a preview can only hide, never reveal.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { route } from '@/lib/api';
import { PERSONAS } from '@/lib/access/types';
import { accessToJson } from '@/lib/access/serialize';
import { canPreview } from '@/lib/access/derive';
import { forbiddenBody } from '@/lib/access/guard';
import { PREVIEW_COOKIE, getAccessPreviewing, getRealAccess } from '@/lib/access/server';

export const dynamic = 'force-dynamic';

const COOKIE = { httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production', path: '/' };
const EIGHT_HOURS = 60 * 60 * 8;

const Body = z.object({ persona: z.enum(PERSONAS) });

export const POST = route({ access: 'none', body: Body, allowReadOnly: true, mask: false }, async ({ body }) => {
  const real = await getRealAccess();
  if (!canPreview(real.grants)) return NextResponse.json(forbiddenBody('projects.settings', 'configure'), { status: 403 });
  const previewed = await getAccessPreviewing(body.persona);
  const res = NextResponse.json({ ok: true, preview: body.persona, access: accessToJson(previewed) });
  res.cookies.set(PREVIEW_COOKIE, body.persona, { ...COOKIE, maxAge: EIGHT_HOURS });
  return res;
});

export const DELETE = route({ access: 'none', allowReadOnly: true, mask: false }, async () => {
  const real = await getRealAccess();
  const res = NextResponse.json({ ok: true, preview: null, access: accessToJson(real) });
  res.cookies.set(PREVIEW_COOKIE, '', { ...COOKIE, maxAge: 0 });
  return res;
});
