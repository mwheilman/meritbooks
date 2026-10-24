import { ButtonLink, WidgetState } from '@meritbooks/merit-ui';

/** The lead flow's tables are not in this database yet (migration 1111): say so plainly. */
export function CrmNotLive({ what }: { what: string }) {
  return (
    <div className="surface" style={{ maxWidth: 720 }}>
      <WidgetState
        state={{
          kind: 'empty',
          title: `${what} are being set up`,
          body: 'Your workspace is getting the shared customer, contact and lead records Merit Projects and Merit Books both use. This page opens as soon as that update is in place; nothing you have is affected.',
          action: <ButtonLink href="/jobs">Open jobs</ButtonLink>,
        }}
      />
    </div>
  );
}
