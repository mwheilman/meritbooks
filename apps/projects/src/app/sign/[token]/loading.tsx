import { WidgetState } from '@meritbooks/merit-ui';

export default function Loading() {
  return <div style={{ padding: 24 }}><WidgetState state={{ kind: 'loading', label: 'Opening the document…', lines: 6 }} /></div>;
}
