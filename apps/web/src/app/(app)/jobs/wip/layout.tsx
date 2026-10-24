import type { ReactNode } from 'react';
import { pageTitle } from '@meritbooks/merit-ui';

// Tab title for this route. The page is a client component (or owned by another
// slice), so the metadata lives on this pass-through server layout.
// Absolute, so the nested /jobs layout title can never stand in for it (Wave 2 live check).
export const metadata = { title: { absolute: pageTitle('WIP schedule', 'books') } };

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
