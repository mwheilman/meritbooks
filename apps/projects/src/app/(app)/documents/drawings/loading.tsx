import { Page, PageHead, WidgetState } from '@meritbooks/merit-ui';

export default function Loading() {
  return <Page><PageHead title="Drawings" /><WidgetState state={{ kind: 'loading', label: 'Loading drawings…', lines: 8 }} /></Page>;
}
