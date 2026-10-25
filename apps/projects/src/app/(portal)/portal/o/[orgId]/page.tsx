import { InlineNotice } from '@meritbooks/merit-ui';
import { PortalFrame } from '@/components/portal/PortalFrame';
import { QueueList } from '@/components/portal/QueueList';
import { date } from '@/lib/portal/format';
import { orgFrame } from '@/lib/portal/frame';
import { t } from '@/lib/portal/i18n';
import { loadPortal } from '@/lib/portal/load';
import type { PortalHome } from '@/lib/portal/types';

export const dynamic = 'force-dynamic';

/** Home: everything waiting on the person (deadline + $ impact), then their projects. */
export default async function PortalHomePage({ params }: { params: { orgId: string } }) {
  const f = await orgFrame(params.orgId);
  const home = await loadPortal<PortalHome>('home', { p_org: f.orgId });
  const L = f.locale;
  return (
    <PortalFrame locale={L} brand={f.brand} orgId={f.orgId} audiences={f.audiences} active="home" signedIn multiOrg={f.multiOrg}>
      {!home.ok ? <InlineNotice tone="neg" title={home.code === 'forbidden' ? t(L, 'err.not_found') : home.message} /> : (
        <>
          <h1>{t(L, 'home.title')}</h1>
          <QueueList orgId={f.orgId} items={home.data.queue} locale={L} />
          <h2>{t(L, 'home.jobs')}</h2>
          {home.data.jobs.map((j) => (
            <a key={j.id} className="pt-card" href={`/portal/o/${f.orgId}/jobs/${j.id}`}>
              <div className="top"><span className="pt-cap">{j.company} · {j.number}</span></div>
              <div className="ttl">{j.name}</div>
              {j.next_milestone && (
                <div className="meta">{t(L, 'home.next', { title: j.next_milestone.title, when: date(j.next_milestone.on, L) })}</div>
              )}
            </a>
          ))}
        </>
      )}
    </PortalFrame>
  );
}
