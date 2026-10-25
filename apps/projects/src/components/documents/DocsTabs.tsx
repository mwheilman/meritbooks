import Link from 'next/link';

/** Files · Drawings · Templates for the job in view (plain links: each is its own page). */
export function DocsTabs({ active, jobId }: { active: 'files' | 'drawings' | 'templates'; jobId: string | null }) {
  const q = jobId ? `?job=${jobId}` : '';
  const items = [
    { key: 'files', label: 'Files', href: `/documents${q}` },
    { key: 'drawings', label: 'Drawings', href: `/documents/drawings${q}` },
    { key: 'templates', label: 'Create from template', href: `/documents/templates${q}` },
  ] as const;
  return (
    <nav className="tabs" role="tablist" aria-label="Documents" style={{ marginBottom: 16 }}>
      {items.map((t) => (
        <Link key={t.key} href={t.href} className="tab" role="tab" aria-current={t.key === active ? 'page' : undefined} aria-selected={t.key === active}>{t.label}</Link>
      ))}
    </nav>
  );
}
