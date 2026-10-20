/** Compile-time check: next/link satisfies the provider's LinkComponent (tsc includes test/). */
import NextLink from 'next/link';
import { describe, expect, it } from 'vitest';
import type { LinkComponent } from '../src/provider';

const link: LinkComponent = NextLink;

describe('next/link compatibility', () => {
  it('next/link is assignable to LinkComponent', () => {
    expect(link).toBeDefined();
  });
});
