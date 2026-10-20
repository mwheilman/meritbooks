import { Page, WidgetState } from '@meritbooks/merit-ui';

/** Route-level loading state for the ops pages: what is loading, shaped like the page. */
export function OpsLoading({ label }: { label: string }) {
  return (
    <Page>
      <div className="wg wg-loading" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }} aria-busy="true">
        <WidgetState state={{ kind: 'loading', label, lines: 5 }} />
      </div>
    </Page>
  );
}
