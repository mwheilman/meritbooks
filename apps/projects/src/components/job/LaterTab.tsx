import Link from 'next/link';
import { WidgetState } from '@meritbooks/merit-ui';

/** An honest placeholder for a section that ships in a later release, with where the work lives today. */
export function LaterTab({ label, what, meanwhile }: { label: string; what: string; meanwhile?: { label: string; href: string } }) {
  return (
    <div className="surface">
      <WidgetState
        state={{
          kind: 'empty',
          title: `${label} arrives in a later release`,
          body: what,
          action: meanwhile ? <Link className="btn" href={meanwhile.href}>{meanwhile.label}</Link> : undefined,
        }}
      />
    </div>
  );
}
