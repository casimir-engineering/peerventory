/**
 * MV3 service worker. Its one real job: answer the content scripts' AI
 * requests (Anibis category picks) so the Anthropic key stays out of page
 * contexts and the call runs with the extension's api.anthropic.com host
 * permission. Everything else still happens in the popup and the content
 * scripts.
 *
 * Messages:
 *  - PV_AI_AVAILABLE            -> { available: boolean }  (a key is linked)
 *  - PV_AI_CATEGORY {options, item} -> { index: number | null }
 *    `options` are the scraped labels of one live menu level; `index` is the
 *    0-based option to click, null = AI unsure/failed (caller falls back to
 *    the synonyms heuristic; a fill must never block on this).
 */

import { aiPickOption, type AiPickItem } from './ai';
import { getAiSettings } from './storage';

chrome.runtime.onInstalled.addListener(() => {
  // no-op
});

interface PickRequest {
  type: 'PV_AI_CATEGORY';
  options: unknown;
  item: unknown;
}

async function handlePick(msg: PickRequest): Promise<{ index: number | null }> {
  const { key } = await getAiSettings();
  const options = Array.isArray(msg.options)
    ? msg.options.filter((o): o is string => typeof o === 'string')
    : [];
  const item = (msg.item ?? {}) as AiPickItem;
  if (!key || options.length === 0 || typeof item.title !== 'string') return { index: null };
  try {
    return { index: await aiPickOption(options, item, key) };
  } catch {
    return { index: null };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  const type = (msg as { type?: string }).type;
  if (type === 'PV_AI_AVAILABLE') {
    getAiSettings()
      .then((s) => sendResponse({ available: Boolean(s.key) }))
      .catch(() => sendResponse({ available: false }));
    return true;
  }
  if (type === 'PV_AI_CATEGORY') {
    handlePick(msg as PickRequest)
      .then(sendResponse)
      .catch(() => sendResponse({ index: null }));
    return true;
  }
  return false;
});
