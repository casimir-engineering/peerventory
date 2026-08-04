/**
 * Client-side content encryption for end-to-end encrypted inventories.
 * See CONTRACTS.md ("End-to-end encryption"). The 256-bit content key never
 * leaves the client: it travels only in URL fragments / QR codes / backup
 * payloads and lives in the local registry.
 *
 * - Yjs updates: AES-256-GCM, random 96-bit IV, AAD = docId (prevents
 *   replaying ciphertext from one doc into another).
 * - Photo blobs: AES-256-GCM over an envelope [mimeLen u16 BE | mime | bytes]
 *   with a DETERMINISTIC IV derived as HMAC-SHA256(key, "photo-iv" + sha256(plain))
 *   truncated to 96 bits. Same key + same plaintext -> same ciphertext, so
 *   content addressing and upload dedupe keep working. Binding the IV to the
 *   plaintext hash makes IV reuse impossible for distinct plaintexts.
 *   Stored/uploaded bytes = iv (12) || GCM ciphertext+tag.
 */

const IV_BYTES = 12;
const KEY_BYTES = 32;

export interface DocKey {
  aes: CryptoKey;
  hmac: CryptoKey;
}

/* ---------- base64url ---------- */

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(value: string): Uint8Array | null {
  try {
    const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** 43-char base64url string encoding 32 random bytes. */
export function generateContentKey(): string {
  const bytes = new Uint8Array(KEY_BYTES);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

const KEY_RE = /^[A-Za-z0-9_-]{43}$/;

export function isValidContentKey(value: string): boolean {
  return KEY_RE.test(value) && base64UrlToBytes(value)?.length === KEY_BYTES;
}

/** Imports the base64url content key for AES-GCM and for IV derivation. */
export async function importContentKey(keyB64: string): Promise<DocKey> {
  const raw = base64UrlToBytes(keyB64);
  if (!raw || raw.length !== KEY_BYTES) {
    throw new Error('Invalid content key');
  }
  const buf = raw.buffer as ArrayBuffer;
  const aes = await crypto.subtle.importKey('raw', buf, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
  const hmac = await crypto.subtle.importKey(
    'raw',
    buf,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return { aes, hmac };
}

/* ---------- Yjs update encryption ---------- */

export interface EncryptedChunk {
  iv: Uint8Array;
  ct: Uint8Array;
}

export async function encryptUpdate(
  key: DocKey,
  docId: string,
  update: Uint8Array,
): Promise<EncryptedChunk> {
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(docId) },
    key.aes,
    update.slice().buffer as ArrayBuffer,
  );
  return { iv, ct: new Uint8Array(ct) };
}

export async function decryptUpdate(
  key: DocKey,
  docId: string,
  chunk: EncryptedChunk,
): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: chunk.iv.slice().buffer as ArrayBuffer, additionalData: new TextEncoder().encode(docId) },
    key.aes,
    chunk.ct.slice().buffer as ArrayBuffer,
  );
  return new Uint8Array(pt);
}

/* ---------- photo blob encryption ---------- */

async function derivePhotoIv(key: DocKey, plainHashHex: string): Promise<Uint8Array> {
  const input = new TextEncoder().encode('peerventory:photo-iv:' + plainHashHex);
  const mac = await crypto.subtle.sign('HMAC', key.hmac, input.slice().buffer as ArrayBuffer);
  return new Uint8Array(mac).slice(0, IV_BYTES);
}

async function sha256HexOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Deterministically encrypts photo bytes + mime. Returns the wire bytes
 * (iv || ciphertext) whose sha256 is the blob's content address.
 */
export async function encryptPhoto(
  key: DocKey,
  plain: Uint8Array,
  mime: string,
): Promise<Uint8Array> {
  const mimeBytes = new TextEncoder().encode(mime);
  if (mimeBytes.length > 0xffff) throw new Error('mime too long');
  const envelope = new Uint8Array(2 + mimeBytes.length + plain.length);
  envelope[0] = mimeBytes.length >> 8;
  envelope[1] = mimeBytes.length & 0xff;
  envelope.set(mimeBytes, 2);
  envelope.set(plain, 2 + mimeBytes.length);

  const iv = await derivePhotoIv(key, await sha256HexOf(envelope));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.slice().buffer as ArrayBuffer },
    key.aes,
    envelope.slice().buffer as ArrayBuffer,
  );
  const out = new Uint8Array(IV_BYTES + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), IV_BYTES);
  return out;
}

export async function decryptPhoto(
  key: DocKey,
  wire: Uint8Array,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  if (wire.length <= IV_BYTES) return null;
  try {
    const iv = wire.slice(0, IV_BYTES);
    const ct = wire.slice(IV_BYTES);
    const pt = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
        key.aes,
        ct.buffer as ArrayBuffer,
      ),
    );
    if (pt.length < 2) return null;
    const mimeLen = (pt[0] << 8) | pt[1];
    if (pt.length < 2 + mimeLen) return null;
    const mime = new TextDecoder().decode(pt.slice(2, 2 + mimeLen));
    return { bytes: pt.slice(2 + mimeLen), mime };
  } catch {
    return null;
  }
}
