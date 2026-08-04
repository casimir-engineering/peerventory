/**
 * Read-only subset of the app's content crypto (app/src/store/crypto.ts),
 * shapes fixed by CONTRACTS.md ("End-to-end encryption"):
 *
 * - Yjs update chunks: AES-256-GCM, 96-bit IV, AAD = docId bytes.
 * - Photo blobs: wire = iv(12) || AES-GCM(envelope) with
 *   envelope = mimeLen(u16 BE) || mime || imageBytes.
 *
 * The connector only ever DECRYPTS, so the HMAC half of the key (photo IV
 * derivation, needed for encryption only) is not imported.
 *
 * Uses globalThis.crypto: window.crypto in the popup, node:crypto.webcrypto
 * (global since Node 19) in the unit tests.
 */

const IV_BYTES = 12;
const KEY_BYTES = 32;

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

/** Copy into a plain ArrayBuffer (WebCrypto BufferSource rejects views on pooled buffers). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function importContentKey(keyB64: string): Promise<CryptoKey> {
  const raw = base64UrlToBytes(keyB64);
  if (!raw || raw.length !== KEY_BYTES) throw new Error('Invalid content key');
  return crypto.subtle.importKey('raw', toArrayBuffer(raw), { name: 'AES-GCM' }, false, [
    'decrypt',
  ]);
}

export async function decryptUpdate(
  key: CryptoKey,
  docId: string,
  chunk: { iv: Uint8Array; ct: Uint8Array },
): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(chunk.iv),
      additionalData: new TextEncoder().encode(docId),
    },
    key,
    toArrayBuffer(chunk.ct),
  );
  return new Uint8Array(pt);
}

export async function decryptPhoto(
  key: CryptoKey,
  wire: Uint8Array,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  if (wire.length <= IV_BYTES) return null;
  try {
    const pt = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: toArrayBuffer(wire.slice(0, IV_BYTES)) },
        key,
        toArrayBuffer(wire.slice(IV_BYTES)),
      ),
    );
    if (pt.length < 2) return null;
    const mimeLen = (pt[0] << 8) | pt[1];
    if (pt.length < 2 + mimeLen) return null;
    return {
      mime: new TextDecoder().decode(pt.slice(2, 2 + mimeLen)),
      bytes: pt.slice(2 + mimeLen),
    };
  } catch {
    return null;
  }
}
