import { Page, WidgetState } from '@meritbooks/merit-ui';

/** Route-level loading state for the money pages. */
export function MoneyLoading({ label }: { label: string }) {
  return (
    <Page>
      <div className="wg wg-loading" style={{ maxWidth: 720, padding: 24 }} aria-busy="true">
        <WidgetState state={{ kind: 'loading', label, lines: 6 }} />
      </div>
    </Page>
  );
}
