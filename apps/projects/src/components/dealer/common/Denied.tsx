import { ButtonLink, InlineNotice } from '@meritbooks/merit-ui';

/** In-page access answer for screens whose area has no rail rule yet: says what is missing, never shows the data. */
export function Denied({ what }: { what: string }) {
  return (
    <div className="stack">
      <InlineNotice tone="info" title={`${what} is not part of your role here.`}>
        Ask an owner to add it to your role, or switch to a company where you have it.
      </InlineNotice>
      <p><ButtonLink variant="quiet" href="/">Back to Home</ButtonLink></p>
    </div>
  );
}
