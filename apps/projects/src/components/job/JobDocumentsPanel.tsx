import { ButtonLink, WidgetState } from '@meritbooks/merit-ui';

/**
 * The job's Documents tab: the job's files and its drawing sets live on the Documents screens
 * (1115), opened on this job. One place to manage them, linked from here.
 */
export function JobDocumentsPanel({ jobId, canDrawings }: { jobId: string; canDrawings: boolean }) {
  return (
    <div className="surface">
      <WidgetState
        state={{
          kind: 'empty',
          title: 'Files, photos and drawings for this job',
          body: 'Contracts, signed change orders, photos and drawing sets are kept in Documents, filed under this job.',
          action: (
            <span className="btn-row">
              <ButtonLink variant="primary" href={`/documents?job=${jobId}`}>Open files</ButtonLink>
              {canDrawings && <ButtonLink href={`/documents/drawings?job=${jobId}`}>Open drawings</ButtonLink>}
            </span>
          ),
        }}
      />
    </div>
  );
}
