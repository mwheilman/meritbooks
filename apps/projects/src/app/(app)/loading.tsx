import { Page, WidgetState } from '@meritbooks/merit-ui';

export default function Loading() {
  return (
    <Page>
      <div className="wg wg-loading" style={{ maxWidth: 720, padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }} aria-busy="true">
        <WidgetState state={{ kind: 'loading', label: 'Loading your jobs…', lines: 5 }} />
      </div>
    </Page>
  );
}
