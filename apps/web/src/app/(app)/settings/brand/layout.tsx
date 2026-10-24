import type { ReactNode } from 'react';

// Tab title for this route (the page body is a client component).
export const metadata = { title: 'Brand' };

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
