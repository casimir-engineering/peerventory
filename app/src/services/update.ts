/**
 * Sideload updates for the Android APK.
 *
 * The app is distributed as a signed APK from GitHub Releases, not a store, so
 * nothing tells the phone a new build exists. This polls the public releases
 * API (unauthenticated, 60 requests/hour per IP — far above what one device
 * needs) and compares the release tag against the version compiled into this
 * build.
 *
 * Web/PWA users are served by the service worker and never see any of this.
 */

import { Capacitor } from '@capacitor/core';

const RELEASES_API = 'https://api.github.com/repos/casimir-engineering/peerventory/releases/latest';

/** Injected by vite from app/package.json; see vite.config.ts. */
export const APP_VERSION: string = __APP_VERSION__;

/** Updates are only actionable inside the APK — the website updates itself. */
export function updatesSupported(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export interface AvailableUpdate {
  /** Release version without the leading "v", e.g. "1.2.0". */
  version: string;
  /** Release body as written by the release script; may be empty. */
  notes: string;
  /** Browser download URL of the .apk asset. */
  apkUrl: string;
}

interface GithubAsset {
  name?: unknown;
  browser_download_url?: unknown;
}

interface GithubRelease {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: unknown;
}

/** [1, 2, 3] from "v1.2.3"; missing or non-numeric parts count as 0. */
function parseSemver(raw: string): [number, number, number] {
  const parts = raw.trim().replace(/^v/i, '').split('-')[0].split('.');
  const n = (i: number) => {
    const v = Number.parseInt(parts[i] ?? '0', 10);
    return Number.isFinite(v) ? v : 0;
  };
  return [n(0), n(1), n(2)];
}

/** True when `candidate` is a strictly newer version than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/**
 * Resolves to the newer release, or null when up to date / offline / rate
 * limited. Never throws: a failed update check must not disturb the app.
 */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  if (!updatesSupported()) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
    if (!res.ok) return null;

    const release = (await res.json()) as GithubRelease;
    if (release.draft === true || release.prerelease === true) return null;

    const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
    if (!tag) return null;
    const version = tag.replace(/^v/i, '');
    if (!isNewerVersion(version, APP_VERSION)) return null;

    const assets = Array.isArray(release.assets) ? (release.assets as GithubAsset[]) : [];
    const apk = assets.find(
      (a) => typeof a.name === 'string' && a.name.toLowerCase().endsWith('.apk'),
    );
    const apkUrl = typeof apk?.browser_download_url === 'string' ? apk.browser_download_url : '';
    if (!apkUrl) return null;

    const notes = typeof release.body === 'string' ? release.body.trim() : '';
    return { version, notes, apkUrl };
  } catch {
    // Offline, DNS failure, rate limit, malformed payload — all mean "no update
    // to offer right now".
    return null;
  }
}

/**
 * Hands the APK URL to the system browser, which downloads it through the
 * Android download manager and then offers to install it.
 *
 * Capacitor routes both an external `window.open` and a top-level navigation to
 * a non-app URL out to an ACTION_VIEW intent; the second call is the fallback
 * for the rare device where `window.open` is blocked.
 */
export function startUpdateDownload(update: AvailableUpdate): void {
  const opened = window.open(update.apkUrl, '_blank', 'noopener');
  if (!opened) window.location.href = update.apkUrl;
}

/** Release page for the changelog, used by the "What's new" link. */
export function releasePageUrl(version: string): string {
  return `https://github.com/casimir-engineering/peerventory/releases/tag/v${version}`;
}
