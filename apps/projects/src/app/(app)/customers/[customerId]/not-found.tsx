import { ButtonLink, Page, WidgetState } from '@meritbooks/merit-ui';

export default function CustomerNotFound() {
  return (
    <Page>
      <div className="surface" style={{ maxWidth: 640 }}>
        <WidgetState state={{ kind: 'empty', title: 'That customer is not in this workspace', body: 'It may have been merged into another customer, or it belongs to a company you can’t see.', action: <ButtonLink href="/customers">Open customers</ButtonLink> }} />
      </div>
    </Page>
  );
}
