'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { EquityReview, type EntityOption } from '@/components/onboarding/equity-review';

/**
 * Client wrapper for the equity / cap-table onboarding surface. Fetches the tenant's
 * companies (RLS-scoped `/api/locations`) and renders the review table. Degrade-safe:
 * an empty company list still renders with a clear empty state inside EquityReview.
 */
export default function EquityClient() {
  const [entities, setEntities] = useState<EntityOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/locations')
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => {
        if (cancelled) return;
        const list = Array.isArray(d) ? d : [];
        setEntities(list.map((l: { id: string; name: string }) => ({ id: l.id, name: l.name })));
      })
      .catch(() => setEntities([]))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-slate-400">
        <Loader2 size={14} className="animate-spin" /> Loading companies…
      </p>
    );
  }

  return <EquityReview entities={entities} />;
}
