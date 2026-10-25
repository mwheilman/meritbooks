'use client';

import { Page, PageHead, WidgetState } from '@meritbooks/merit-ui';

export default function ApprovalsError({ reset }: { error: Error; reset: () => void }) {
  return (
    <Page>
      <PageHead eyebrow="Approvals" title="Approvals" />
      <WidgetState state={{ kind: 'error', title: 'Approvals did not load', body: 'Your decisions are safe; nothing was changed. Try again in a moment.', onRetry: reset }} />
    </Page>
  );
}
