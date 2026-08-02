import Link from 'next/link';
import { currentOrgId, getEntitlements, hasModule } from '@/lib/entitlements';
import { Nav } from '@/components/nav';
import { CommandBar } from '@/components/command-bar';

// Entitlements gate: MeritProjects renders ONLY if the tenant owns the module.
// Standalone-sellable and bundle-safe, decided by core.organizations.entitlements
// (Suite Core owns it; Projects only reads it). A Books-only tenant never sees this.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const orgId = await currentOrgId();
  const ents = await getEntitlements(orgId);

  if (!hasModule(ents, 'projects')) {
    return (
      <div className="min-h-screen grid place-items-center bg-surface-950 px-6">
        <div className="max-w-md text-center space-y-3">
          <div className="text-heading font-semibold text-white">MeritProjects isn&apos;t enabled</div>
          <p className="text-sm text-slate-400">
            This organization doesn&apos;t own the Projects module yet. An administrator can enable it in
            Suite settings (<span className="num">entitlements.projects</span>).
          </p>
          <Link href="/sign-in" className="inline-block text-sm text-brand-400 hover:text-brand-300">
            Switch account
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex bg-surface-950">
      <Nav />
      <main className="flex-1 min-w-0 p-8">{children}</main>
      <CommandBar />
    </div>
  );
}
