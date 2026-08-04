/**
 * Intentionally (almost) empty MV3 service worker. The extension needs no
 * background logic — everything happens in the popup and the content scripts.
 * The worker exists so tooling (and the automated tests) can discover the
 * extension ID, and as the place where future logic would live.
 */
'use strict';

chrome.runtime.onInstalled.addListener(() => {
  // no-op
});
