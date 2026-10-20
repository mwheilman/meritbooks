'use client';

import { useRouter } from 'next/navigation';
import { Seg } from '@meritbooks/merit-ui';

/** Work board (cockpit) ⇄ Report density. Defaults by role; the choice rides the URL. */
export function HomeViewToggle({ value }: { value: 'cockpit' | 'report' }) {
  const router = useRouter();
  return (
    <Seg
      aria-label="Home view"
      value={value}
      onChange={(v) => router.replace(`/?view=${v}`)}
      items={[
        { value: 'cockpit', label: 'Work board' },
        { value: 'report', label: 'Report' },
      ]}
    />
  );
}
