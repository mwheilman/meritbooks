'use client';

import { Button } from '@meritbooks/merit-ui';

/** Print the page (the store print rules hide the shell). */
export function PrintButton({ label = 'Print' }: { label?: string }) {
  return <Button variant="primary" icon="file-text" chord="mod+p" onClick={() => window.print()}>{label}</Button>;
}
