'use client';

import { useEffect } from 'react';
import { ButtonLink, Page, WidgetState } from '@meritbooks/merit-ui';

/** Route-level error state for the store pages: what failed, what to do, retry. */
export function StoreError({ what, error, reset }: { what: string; error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error(`[store ${what}]`, error);
  }, [error, what]);
  return (
    <Page>
      <div className="surface" style={{ maxWidth: 640 }}>
        <WidgetState
          state={{
            kind: 'error',
            title: `${what} did not load`,
            body: 'The database did not answer in time or refused the request. Nothing you entered was lost; try again, and if it repeats, tell support what you were doing.',
            onRetry: reset,
            retryLabel: 'Try again',
          }}
        />
        <p style={{ marginTop: 12 }}><ButtonLink variant="quiet" href="/">Back to Home</ButtonLink></p>
      </div>
    </Page>
  );
}
