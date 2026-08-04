/** ID/token generation and hashing. See CONTRACTS.md ("IDs and tokens"). */
import { customAlphabet } from 'nanoid';
import type { Id } from '../types';

const BASE58 =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const genId = customAlphabet(BASE58, 10);
const genToken = customAlphabet(BASE58, 16);

/** 10-char base58 nanoid, used for all entity IDs. */
export function newId(): Id {
  return genId();
}

/** 16-char base58 nanoid, used for rw/ro tokens. */
export function newToken(): string {
  return genToken();
}

/** sha256 as lowercase hex, via WebCrypto. */
export async function sha256Hex(data: string | ArrayBuffer): Promise<string> {
  const bytes =
    typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
