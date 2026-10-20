import { ButtonLink, Page, WidgetState } from '@meritbooks/merit-ui';

export default function JobNotFound() {
  return (
    <Page>
      <div className="surface" style={{ maxWidth: 640 }}>
        <WidgetState
          state={{
            kind: 'empty',
            title: 'That job is not in this workspace',
            body: 'It may have been a sample job that was removed, or it belongs to a company you can’t see. Switch company with ⌘J, or open the list.',
            action: <ButtonLink href="/jobs">Open jobs</ButtonLink>,
          }}
        />
      </div>
    </Page>
  );
}
