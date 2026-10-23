export const dynamic = 'force-dynamic';

import { StatementsList } from './_components/statements-list';

export const metadata = { title: 'Manufacturer statements' };

/**
 * /dealer/oem-statements — manufacturer statements (FPB-dealer-pack §3.8–3.9, §5 A2/A3).
 * Manual entry here; AI / CSV import of statements lives in /dealer/imports.
 */
export default function OemStatementsPage() {
  return <StatementsList />;
}
