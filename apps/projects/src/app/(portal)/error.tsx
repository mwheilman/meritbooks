'use client';

import { Button, InlineNotice } from '@meritbooks/merit-ui';

export default function PortalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="pt">
      <main className="pt-main">
        <InlineNotice tone="neg" title="That did not load. / No se pudo cargar.">
          <Button onClick={reset}>Try again / Intentar de nuevo</Button>
        </InlineNotice>
      </main>
    </div>
  );
}
