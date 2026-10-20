import { ButtonLink, WidgetState } from '@meritbooks/merit-ui';

/** A module the company's job types do not use: say so, and where to turn it on. Server-safe. */
export function ModuleOff({ title, what }: { title: string; what: string }) {
  return (
    <div className="surface" style={{ maxWidth: 720 }}>
      <WidgetState
        state={{
          kind: 'empty',
          title: `${title} is not turned on for this company`,
          body: `${what} Turn it on for a job type in Settings and it appears in the rail and on those jobs.`,
          action: <ButtonLink href="/settings">Open settings</ButtonLink>,
        }}
      />
    </div>
  );
}
