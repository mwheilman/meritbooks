import { ButtonLink, Page, WidgetState } from '@meritbooks/merit-ui';

export default function NotFound() {
  return (
    <Page>
      <div className="surface" style={{ maxWidth: 640 }}>
        <WidgetState state={{ kind: 'empty', title: 'That page is not part of Merit Projects', body: 'Check the address, or use ⌘K to jump to a job, a customer or a page.', action: <ButtonLink href="/">Go home</ButtonLink> }} />
      </div>
    </Page>
  );
}
