/**
 * Barrel of the pure (browser-API-free) logic, bundled to test/.tmp/core.mjs
 * by build.mjs so the Node unit tests exercise exactly the code the popup
 * ships. Everything here must run under Node's global webcrypto.
 */

export { parseProfileLink, decodeHandles, buildProfile, syncToken } from './backup';
export {
  base64UrlToBytes,
  bytesToBase64Url,
  decryptPhoto,
  decryptUpdate,
  importContentKey,
} from './crypto';
export { ENC_LOG_NAME, decryptOuterDoc, readInventory, toExtItem } from './materialize';
// Chrome-free as well (needs a WebSocket global: browser or Node >= 22).
export { syncInventory } from './sync';
export {
  buildListingPayload,
  isListingPayload,
  itemTitle,
  matchesQuery,
  suggestPrice,
} from './listing';
export type * from './types';
