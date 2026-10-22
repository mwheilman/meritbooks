import { ButtonLink, InlineNotice, WidgetState } from '@meritbooks/merit-ui';

/** The store screens belong to dealer companies: say so, and how to get there. Server-safe. */
export function StoreOff({ title, what }: { title: string; what: string }) {
  return (
    <div className="surface" style={{ maxWidth: 720 }}>
      <WidgetState
        state={{
          kind: 'empty',
          title: `${title} is for equipment dealers`,
          body: `${what} It turns on for a company set up with the Equipment dealer industry pack, or one with a dealer service job type.`,
          action: <ButtonLink href="/settings">Open settings</ButtonLink>,
        }}
      />
    </div>
  );
}

/** In a multi-company view, store records belong to one company: this says so instead of guessing. */
export function PickStoreNote({ what }: { what: string }) {
  return (
    <InlineNotice tone="info" title="Switch to one store to add records.">
      {what} belong to one company. Use the company switcher in the bar; everything here stays readable meanwhile.
    </InlineNotice>
  );
}
