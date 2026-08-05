/**
 * Update affordances for the sideloaded Android build.
 *
 * `UpdateBanner` is the passive path: one silent check per app start, and if a
 * newer release exists a dismissible strip appears above the current page.
 * `UpdateSection` is the active path on Account & sync — it always shows the
 * installed version and lets the user check on demand.
 *
 * Both render nothing on web, where the service worker already keeps the app
 * current (the section degrades to a plain version line).
 */

import { useEffect, useState } from 'react';

import {
  APP_VERSION,
  checkForUpdate,
  releasePageUrl,
  startUpdateDownload,
  updatesSupported,
} from '../../services/update';
import type { AvailableUpdate } from '../../services/update';
import { SectionTitle, Spinner } from './Common';

/** Releases the user already said "later" to, so the banner stays quiet. */
const DISMISSED_KEY = 'update:dismissed:v1';

function dismissedVersion(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

/** Trimmed changelog: the release notes' bullet lines, at most a handful. */
function summarize(notes: string, maxLines = 6): string[] {
  return notes
    .split('\n')
    .map((line) => line.replace(/^\s*[-*]\s+/, '').trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .slice(0, maxLines);
}

export function UpdateBanner() {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);

  useEffect(() => {
    if (!updatesSupported()) return;
    let alive = true;
    void checkForUpdate().then((found) => {
      if (!alive || !found) return;
      if (dismissedVersion() === found.version) return;
      setUpdate(found);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!update) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, update.version);
    } catch {
      // A full storage quota is no reason to trap the user under the banner.
    }
    setUpdate(null);
  };

  return (
    <div className="update-banner">
      <div className="grow">
        <div className="small">Update {update.version} available</div>
        <div className="tiny faint">You have {APP_VERSION}. Downloads from GitHub.</div>
      </div>
      <button type="button" className="btn primary sm" onClick={() => startUpdateDownload(update)}>
        Download
      </button>
      <button type="button" className="link-btn" onClick={dismiss} aria-label="Dismiss update notice">
        Later
      </button>
    </div>
  );
}

export function UpdateSection() {
  const [busy, setBusy] = useState(false);
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [checked, setChecked] = useState(false);

  const native = updatesSupported();

  const check = () => {
    if (busy) return;
    setBusy(true);
    void checkForUpdate().then((found) => {
      setUpdate(found);
      setChecked(true);
      setBusy(false);
    });
  };

  return (
    <section className="card stack tight">
      <SectionTitle>App version</SectionTitle>
      <div className="row between">
        <div className="grow">
          <div className="tiny faint">Installed</div>
          <div className="small">
            {APP_VERSION}
            {native ? '' : ' · web'}
          </div>
        </div>
        {native ? (
          <button type="button" className="link-btn" disabled={busy} onClick={check}>
            {busy ? <Spinner /> : null} {busy ? 'Checking…' : 'Check for updates'}
          </button>
        ) : null}
      </div>

      {native && update ? (
        <>
          <div className="tiny faint">What&apos;s new in {update.version}</div>
          {summarize(update.notes).map((line, i) => (
            <div key={i} className="tiny">
              · {line}
            </div>
          ))}
          <button
            type="button"
            className="btn primary"
            onClick={() => startUpdateDownload(update)}
          >
            Download {update.version}
          </button>
          <p className="tiny faint">
            Opens your browser to download the APK from{' '}
            <a href={releasePageUrl(update.version)} target="_blank" rel="noreferrer">
              the release page
            </a>
            . Tap the finished download to install; Android asks once for permission to install
            apps from your browser.
          </p>
        </>
      ) : null}

      {native && checked && !update ? (
        <p className="tiny faint">
          You are on the latest release — or GitHub could not be reached just now.
        </p>
      ) : null}

      {native ? null : (
        <p className="tiny faint">
          The website updates itself: close and reopen the tab to pick up a new version.
        </p>
      )}
    </section>
  );
}
