import { WidgetState } from '@meritbooks/merit-ui';

/** An honest placeholder for a module that ships in a later wave. */
export function LaterTab({ label, what }: { label: string; what: string }) {
  return (
    <div className="surface">
      <WidgetState state={{ kind: 'empty', title: `${label} arrives in the next release`, body: what }} />
    </div>
  );
}
