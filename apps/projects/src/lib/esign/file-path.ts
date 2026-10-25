/** A signer's document key: `<org uuid>/pm/{docs,drawings,esign,photos}/<file>` (no traversal). Pure. */
const PM_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/pm\/(docs|drawings|esign|photos)\/[^/]+$/i;

export function isSignerDocumentPath(path: string): boolean {
  return PM_PATH.test(path) && !path.includes('..');
}
