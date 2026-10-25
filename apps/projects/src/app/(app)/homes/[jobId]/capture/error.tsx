'use client';

import { StoreError } from '@/components/dealer/common/StoreError';

export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <StoreError what="Site capture" error={error} reset={reset} />;
}
