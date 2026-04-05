import { PageHeader } from '@/components/ui';
import { ForecastGrid } from './forecast-grid';

export default function ForecastPage() {
  return (
    <>
      <PageHeader
        title="13-Week Cash Forecast"
        description="Rolling forecast with AI intelligence and scenario modeling"
        actions={
          <div className="flex items-center gap-2">
            <button className="btn-ghost btn-sm">Scenarios</button>
            <button className="btn-secondary btn-sm">Export</button>
          </div>
        }
      />
      <ForecastGrid />
    </>
  );
}
