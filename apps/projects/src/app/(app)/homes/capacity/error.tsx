'use client';

import { StoreError } from '@/components/dealer/common/StoreError';

export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <StoreError what="Crew and trade capacity" error={error} reset={reset} />;
}
