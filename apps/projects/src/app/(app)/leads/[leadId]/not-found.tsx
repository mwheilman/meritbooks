import { ButtonLink, Page, WidgetState } from '@meritbooks/merit-ui';

export default function LeadNotFound() {
  return (
    <Page>
      <div className="surface" style={{ maxWidth: 640 }}>
        <WidgetState state={{ kind: 'empty', title: 'That lead is not in this workspace', body: 'It may belong to a company you can’t see. Switch company with ⌘J, or open the list.', action: <ButtonLink href="/leads">Open leads</ButtonLink> }} />
      </div>
    </Page>
  );
}
