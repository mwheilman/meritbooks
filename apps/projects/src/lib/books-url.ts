/** Where Merit Books lives. NEXT_PUBLIC_BOOKS_URL overrides; no trailing slash. Pure. */
export const DEFAULT_BOOKS_URL = 'https://books.meritmgt.com';

export function booksUrl(env: string | undefined = process.env.NEXT_PUBLIC_BOOKS_URL): string {
  return (env || DEFAULT_BOOKS_URL).replace(/\/+$/, '');
}
