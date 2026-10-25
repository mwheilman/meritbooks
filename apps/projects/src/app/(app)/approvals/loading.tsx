import { Page, PageHead, WidgetState } from '@meritbooks/merit-ui';

export default function Loading() {
  return (
    <Page>
      <PageHead eyebrow="Approvals" title="Needs my approval" />
      <WidgetState state={{ kind: 'loading', label: 'Loading your approvals', lines: 5 }} />
    </Page>
  );
}
