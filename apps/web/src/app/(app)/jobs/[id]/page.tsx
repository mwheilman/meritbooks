import { JobDetailClient } from './job-detail-client';

export default function JobDetailPage({ params }: { params: { id: string } }) {
  return <JobDetailClient jobId={params.id} />;
}
