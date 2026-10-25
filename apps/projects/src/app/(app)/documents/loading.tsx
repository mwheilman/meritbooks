import { Page, PageHead, WidgetState } from '@meritbooks/merit-ui';

export default function Loading() {
  return <Page><PageHead title="Documents" /><WidgetState state={{ kind: 'loading', label: 'Loading documents…', lines: 8 }} /></Page>;
}
