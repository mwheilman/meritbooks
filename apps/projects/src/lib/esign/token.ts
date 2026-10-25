/**
 * One-time signing link tokens. The raw token exists only in the link the signer receives;
 * the database stores its SHA-256 (pm.esign_tokens.token_hash) and esign.* re-hashes on use.
 */
import { createHash, randomBytes } from 'node:crypto';

/** 256 bits, URL-safe (43 chars). */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Shape check before a token reaches the database (same rule as esign._resolve). */
export function isTokenShape(token: string): boolean {
  return token.length >= 20 && token.length <= 200 && /^[A-Za-z0-9_-]+$/.test(token);
}

export function signingLink(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/sign/${token}`;
}
