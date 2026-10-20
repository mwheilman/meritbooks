'use client';

import { useEffect } from 'react';
import { Page, WidgetState } from '@meritbooks/merit-ui';

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[projects page]', error);
  }, [error]);
  return (
    <Page>
      <div className="surface" style={{ maxWidth: 640 }}>
        <WidgetState
          state={{
            kind: 'error',
            title: 'This page did not load',
            body: 'The database did not answer in time or refused the request. Your work is saved; try again, and if it repeats, tell support what you were doing.',
            onRetry: reset,
            retryLabel: 'Try again',
          }}
        />
      </div>
    </Page>
  );
}
