import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ACTIVE_COMPANY_COOKIE } from '@/lib/tenant';
import { VIEW_COOKIE } from '@/lib/scope';
import { assertCompany, route } from '@/lib/api';

const YEAR = 60 * 60 * 24 * 365;
const opts = { httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production', path: '/', maxAge: YEAR };

/** Switch the working context: a company, the whole workspace, or the consolidated roll-up. */
export const POST = route(
  { access: 'none', mask: false, body: z.object({ target: z.string().min(1).max(64) }), allowReadOnly: true },
  async ({ body, tenant }) => {
    if (body.target === 'workspace' || body.target === 'consolidated') {
      const res = NextResponse.json({ ok: true, label: body.target === 'workspace' ? `${tenant.orgName ?? 'the workspace'}` : `${tenant.orgName ?? 'Workspace'}, consolidated` });
      res.cookies.set(ACTIVE_COMPANY_COOKIE, '', { ...opts, maxAge: 0 });
      if (body.target === 'consolidated') res.cookies.set(VIEW_COOKIE, 'consolidated', opts);
      else res.cookies.set(VIEW_COOKIE, '', { ...opts, maxAge: 0 });
      return res;
    }
    assertCompany(tenant, body.target);
    const company = tenant.companies.find((c) => c.id === body.target);
    const res = NextResponse.json({ ok: true, label: company?.name ?? 'the company' });
    res.cookies.set(ACTIVE_COMPANY_COOKIE, body.target, opts);
    res.cookies.set(VIEW_COOKIE, '', { ...opts, maxAge: 0 });
    return res;
  },
);
