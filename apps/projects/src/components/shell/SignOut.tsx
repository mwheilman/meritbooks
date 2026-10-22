'use client';

import { SignOutButton } from '@clerk/nextjs';
import { Button } from '@meritbooks/merit-ui';

/** Sign out, as a kit button (Clerk handles the session). */
export function SignOut() {
  return (
    <SignOutButton>
      <Button>Sign out</Button>
    </SignOutButton>
  );
}
