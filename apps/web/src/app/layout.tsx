import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: {
    default: 'MeritBooks',
    template: '%s | MeritBooks',
  },
  description: 'AI-native accounting platform for multi-entity portfolio management.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider
      appearance={{
        variables: {
          colorPrimary: '#10b981',
          borderRadius: '0.75rem',
        },
      }}
    >
      <html lang="en" className="dark">
        <body className="min-h-screen">
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
