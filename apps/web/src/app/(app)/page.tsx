'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

export default function RootPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    fetch('/api/setup')
      .then((r) => r.json())
      .then((data) => {
        if (data.setupComplete) {
          router.replace('/dashboard');
        } else {
          router.replace('/setup');
        }
      })
      .catch(() => {
        router.replace('/dashboard');
      })
      .finally(() => setChecking(false));
  }, [router]);

  if (checking) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-950">
        <div className="text-center">
          <Loader2 className="w-8 h-8 text-emerald-400 animate-spin mx-auto mb-3" />
          <p className="text-sm text-slate-500">Loading MeritBooks...</p>
        </div>
      </div>
    );
  }

  return null;
}
