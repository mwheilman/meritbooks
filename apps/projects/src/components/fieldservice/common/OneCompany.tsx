import { WidgetState } from '@meritbooks/merit-ui';

/** Field-service screens work one company at a time (its board, its capacity, its price book). */
export function OneCompany({ what }: { what: string }) {
  return (
    <div className="surface" style={{ maxWidth: 720 }}>
      <WidgetState state={{ kind: 'empty', title: 'Switch to one company', body: `${what} belong to one company. Use the company switcher in the bar, then come back here.` }} />
    </div>
  );
}

/** First-run state: the company has no field-service setup yet. */
export function NotSetUp({ what, canSeed }: { what: string; canSeed: boolean }) {
  return (
    <div className="surface" style={{ maxWidth: 720 }}>
      <WidgetState
        state={{
          kind: 'empty',
          title: 'Field service is not set up for this company yet',
          body: canSeed
            ? `${what} Open the price book and load the starter setup (business units, arrival windows, scripted job types, capacity and a priced HVAC / plumbing / electrical book) — about a minute.`
            : `${what} Ask an owner to load the starter setup from the price book.`,
        }}
      />
    </div>
  );
}
