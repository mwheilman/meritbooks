/**
 * Client-SAFE helpers for intake storage paths (no next/server, no Supabase).
 *
 * Every drop-and-parse upload lands at `intake/{orgId}/{uuid}-{safeName}` (minted by
 * POST /api/uploads/sign). These helpers are shared by the browser (to render the
 * handoff) and the server (to validate a path a caller hands back to us).
 */

const UUID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i;

/** True when `path` is an object key inside THIS org's intake space (and not a traversal). */
export function isOrgIntakePath(path: string, orgId: string): boolean {
  if (typeof path !== 'string' || !orgId) return false;
  if (path.includes('..') || path.includes('\\')) return false;
  return path.startsWith(`intake/${orgId}/`) && path.length > `intake/${orgId}/`.length;
}

/** The human file name behind a storage path (drops the folder + the uuid prefix). */
export function displayNameFromStoragePath(path: string): string {
  const last = path.split('/').pop() ?? path;
  return last.replace(UUID_PREFIX, '') || last;
}

/** Lower-cased extension of a file name ('' when none). */
export function fileExtension(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** Extensions the server can open and read (AI document parse or deterministic sheet read). */
export const READABLE_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'csv', 'txt', 'tsv', 'xlsx'] as const;
/** Spreadsheet / text extensions read deterministically (no AI needed). */
export const SHEET_EXTENSIONS = ['csv', 'txt', 'tsv', 'xlsx'] as const;

export function isSheetName(name: string): boolean {
  return (SHEET_EXTENSIONS as readonly string[]).includes(fileExtension(name));
}

export function isReadableName(name: string): boolean {
  return (READABLE_EXTENSIONS as readonly string[]).includes(fileExtension(name));
}
