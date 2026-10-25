import { WidgetState } from '@meritbooks/merit-ui';

export default function Loading() {
  return <div className="pt"><main className="pt-main"><WidgetState state={{ kind: 'loading', label: 'Loading…', lines: 6 }} /></main></div>;
}
