import { PageHeader } from '@/components/ui';
import { ReforecastView } from './reforecast-view';

export default function ReforecastPage() {
  return (
    <>
      <PageHeader
        title="Rolling Reforecast"
        description="Blend closed-month actuals with a forward projection into a live full-year latest estimate, measured against the original budget."
      />
      <ReforecastView />
    </>
  );
}
