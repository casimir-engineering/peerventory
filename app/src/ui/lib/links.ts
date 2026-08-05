/**
 * Share-link and route builders. URL shapes are fixed by CONTRACTS.md
 * ("Share links (client-side routing, hash router)").
 */

import { Capacitor } from '@capacitor/core';
import type { Id, InventoryHandle } from '../../types';
import { relayOriginsForDoc } from '../../store/relays';

export type LinkTarget =
  | { kind: 'inventory' }
  | { kind: 'item'; itemId: Id }
  | { kind: 'list'; itemIds: Id[] }
  | { kind: 'savedList'; listId: Id };

/** Selections above these thresholds are shared as a saved list instead. */
export const MAX_INLINE_LIST_ITEMS = 20;
export const MAX_SHARE_URL_LENGTH = 1800;

export function targetSuffix(target: LinkTarget): string {
  switch (target.kind) {
    case 'inventory':
      return '';
    case 'item':
      return `/i/${target.itemId}`;
    case 'list':
      return `/l/${target.itemIds.join('.')}`;
    case 'savedList':
      return `/sl/${target.listId}`;
  }
}

/**
 * Base URL share links point at. Never window.location inside the APK
 * (that would produce dead https://localhost links): always prefer the
 * public server origin baked in at build time.
 */
export function appBaseUrl(): string {
  const publicOrigin = import.meta.env.VITE_SERVER_ORIGIN as string | undefined;
  if (publicOrigin) return publicOrigin.replace(/\/$/, '') + '/';
  const { origin, pathname } = window.location;
  return origin + pathname.replace(/index\.html$/, '');
}

/**
 * Full share URL including a token, for people who have not joined yet.
 * For end-to-end encrypted inventories the content key rides along as
 * `/k/<base64url>` INSIDE the hash fragment: fragments are never sent to any
 * server, so the relay cannot learn the key from the link.
 *
 * The link is based on one of the relays the DOC lives on (each relay also
 * serves the app), so the receiver both loads the app and gets a valid relay
 * hint even when their default relay differs from ours.
 */
export function buildShareUrl(docId: Id, token: string, target: LinkTarget, key?: string): string {
  const keyPart = key ? `/k/${key}` : '';
  const docRelay = relayOriginsForDoc(docId)[0];
  const base = docRelay ? docRelay + '/' : appBaseUrl();
  return `${base}#/join/${docId}/${token}${keyPart}${targetSuffix(target)}`;
}

/** Device-backup restore link (identity + all inventory tokens). */
export function buildBackupUrl(payload: string): string {
  return `${appBaseUrl()}#/restore/${payload}`;
}

export type ShareMode = 'ro' | 'rw';

/**
 * No cross-mode fallback: a device that joined with an edit link never received
 * the read-only token, and handing its edit token out as "view only" would give
 * write access to a forwarder or a customs desk.
 */
export function tokenForMode(handle: InventoryHandle | null, mode: ShareMode): string | null {
  if (!handle) return null;
  return (mode === 'rw' ? handle.rwToken : handle.roToken) ?? null;
}

/** A dot-joined selection is too big to travel inside a URL. */
export function selectionNeedsSavedList(itemIds: Id[], url: string): boolean {
  return itemIds.length > MAX_INLINE_LIST_ITEMS || url.length > MAX_SHARE_URL_LENGTH;
}

export interface ParsedShareLink {
  docId: string;
  token: string;
  /** Content key for E2E inventories, when the link carries one. */
  key?: string;
  /** '' | '/i/<id>' | '/l/<id.id>' | '/sl/<id>' */
  suffix: string;
  /**
   * http(s) origin the link pointed at, when the input carried one. It is a
   * RELAY HINT (a relay the doc is known to live on), not "the" server —
   * callers stash it via rememberRelayHint() so the join flow records it.
   */
  origin?: string;
}

const JOIN_RE =
  /\/join\/([^/\s#?]+)\/([^/\s#?]+)(?:\/k\/([A-Za-z0-9_-]+))?((?:\/(?:i|l|sl)\/[^/\s#?]+)?)/;

const ORIGIN_RE = /^(https?:\/\/[^/#?\s]+)/i;

/**
 * Accepts a full share URL, a bare `#/join/...` fragment, or a `/join/...` path.
 */
export function parseShareLink(input: string): ParsedShareLink | null {
  const trimmed = input.trim();
  const match = JOIN_RE.exec(trimmed);
  if (!match) return null;
  const [, docId, token, key, suffix] = match;
  if (!docId || !token) return null;
  const origin = ORIGIN_RE.exec(trimmed)?.[1];
  return {
    docId,
    token,
    key: key || undefined,
    suffix: suffix ?? '',
    origin: origin || undefined,
  };
}

/** Route to navigate to after a link is pasted (the join route handles the rest). */
export function joinRoute(parsed: ParsedShareLink): string {
  const keyPart = parsed.key ? `/k/${parsed.key}` : '';
  return `/join/${parsed.docId}/${parsed.token}${keyPart}${parsed.suffix}`;
}

export function parseDotIds(dotIds: string | undefined): Id[] {
  if (!dotIds) return [];
  return dotIds.split('.').map((s) => s.trim()).filter(Boolean);
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for insecure contexts / older Android WebViews.
    try {
      const el = document.createElement('textarea');
      el.value = text;
      el.setAttribute('readonly', '');
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * The Android WebView has no `navigator.share`, so the APK goes through the
 * Capacitor plugin instead; the browser build keeps the Web Share API.
 */
export function canShareUrl(): boolean {
  if (Capacitor.isNativePlatform()) return true;
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

/** Opens the OS share sheet. False means it never opened (or was dismissed). */
export async function shareUrl(title: string, url: string): Promise<boolean> {
  try {
    if (Capacitor.isNativePlatform()) {
      const { Share } = await import('@capacitor/share');
      await Share.share({ title, url });
      return true;
    }
    await navigator.share({ title, url });
    return true;
  } catch {
    return false;
  }
}
