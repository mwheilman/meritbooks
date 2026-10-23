import type { ReactNode } from 'react';

// Tab title for this route. The page is a client component (or owned by another
// slice), so the metadata lives on this pass-through server layout.
export const metadata = { title: 'Bank feed' };

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
