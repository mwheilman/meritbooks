import { PageHeader } from '@/components/ui';
import { ForecastGrid } from './forecast-grid';

export default function ForecastPage() {
  return (
    <>
      <PageHeader
        title="13-Week Cash Forecast"
        description="Direct cash projection from bank balances, open AR, and open AP by due date"
      />
      <ForecastGrid />
    </>
  );
}
