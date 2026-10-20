import type { Metadata } from 'next';
import { SignIn } from '@clerk/nextjs';
import { Lockup } from '@meritbooks/merit-ui';

export const metadata: Metadata = { title: 'Sign in' };

export default function SignInPage() {
  return (
    <main className="mp-gate">
      <div className="mp-gate-card">
        <Lockup module="projects" variant="full-color" height={32} />
        <SignIn />
      </div>
    </main>
  );
}
