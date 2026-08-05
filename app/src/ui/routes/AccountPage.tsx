/**
 * Account & sync — the one place for everything that is about YOU and THIS
 * DEVICE rather than about a single inventory: profile name, device linking,
 * account backup/restore, sync relays, the direct device-to-device toggle,
 * the AI key, and leaving the account. Per-inventory options (currency,
 * sharing, exports, privacy toggles) stay inside each inventory's Settings.
 */

import { useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';

import * as services from '../../services';
import { getProfileStatus, subscribeProfileStatus, useInventories } from '../../store';
import type { UseInventoriesResult } from '../../store/contract';
import { AppHeader } from '../components/AppHeader';
import { AiKeyModal, NameModal } from '../components/AccountModals';
import { SectionTitle, Spinner } from '../components/Common';
import { useImportFlow } from '../components/ImportFlow';
import { ConfirmModal, Modal } from '../components/Modal';
import { QrCanvas } from '../components/QrCanvas';
import { useToast } from '../components/Toast';
import { RelaysSection } from '../components/RelaysSection';
import { UpdateSection } from '../components/UpdateBanner';
import { buildAccountBackup } from '../lib/accountBackup';
import { buildBackupUrl, copyToClipboard } from '../lib/links';
import { dataUrlToBlob, useFileSaver } from '../lib/saveFile';

export function AccountPage() {
  const navigate = useNavigate();
  const { toast, toastError } = useToast();
  const { handles, unlinkDevice }: UseInventoriesResult = useInventories();
  const { saveFile } = useFileSaver();

  const [userName, setUserNameState] = useState(() => services.getUserName());
  const [aiKeyMasked, setAiKeyMasked] = useState(() => services.maskedAiKey());
  const [nameModal, setNameModal] = useState(false);
  const [aiKeyModal, setAiKeyModal] = useState(false);
  const [linkModal, setLinkModal] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [zipBusy, setZipBusy] = useState<string | null>(null);
  const restoreInputRef = useRef<HTMLInputElement | null>(null);

  // Restore from file accepts the same formats as home-screen drag & drop.
  const { openFile, modals: importModals } = useImportFlow({
    onAiKeySaved: () => setAiKeyMasked(services.maskedAiKey()),
  });

  const shareAccountZip = async () => {
    if (zipBusy !== null) return;
    setZipBusy('Packing…');
    try {
      const { blob, filename, inventories } = await buildAccountBackup((done, total) =>
        setZipBusy(`Packing ${done}/${total}`),
      );
      await saveFile(
        blob,
        filename,
        `Account backup (${inventories} inventor${inventories === 1 ? 'y' : 'ies'})`,
      );
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'Could not build the account backup');
    } finally {
      setZipBusy(null);
    }
  };

  return (
    <>
      <AppHeader title="Account & sync" subtitle={userName ?? 'Name not set'} back="/" />

      <main className="page narrow">
        <div className="stack loose">
          <section className="card stack tight">
            <SectionTitle>Account &amp; devices</SectionTitle>
            <div className="row between">
              <div className="grow">
                <div className="tiny faint">Your name</div>
                <div className="small">{userName || 'Not set'}</div>
              </div>
              <button type="button" className="link-btn" onClick={() => setNameModal(true)}>
                {userName ? 'Change' : 'Set your name'}
              </button>
            </div>
            <p className="tiny faint">
              {handles.length} inventor{handles.length === 1 ? 'y' : 'ies'} synced across your
              linked devices · <ProfileSyncStatus />
            </p>
            <button type="button" className="btn primary" onClick={() => setLinkModal(true)}>
              Link another device
            </button>
            <p className="tiny faint">
              Shows a QR code. Scan it with Open / Scan on the other device and every inventory —
              including ones you add later — follows through sync.
            </p>
          </section>

          <section className="card stack tight">
            <SectionTitle>Backup &amp; restore</SectionTitle>
            <button
              type="button"
              className="btn"
              disabled={zipBusy !== null}
              onClick={() => void shareAccountZip()}
            >
              {zipBusy !== null ? <Spinner /> : null} {zipBusy ?? 'Share backup (.zip)'}
            </button>
            <p className="tiny faint">
              One file with your whole account and the complete contents of every inventory, photos
              included. Restoring it brings everything back even with no sync server in reach. It
              carries your access tokens and encryption keys — treat it like a password.
            </p>
            <button
              type="button"
              className="btn"
              onClick={() => restoreInputRef.current?.click()}
            >
              Restore / import from file…
            </button>
            <p className="tiny faint">
              Opens an account backup (.zip), a single-inventory export (.zip / .yaml), or a QR
              image. You can also drop the file anywhere on the home screen.
            </p>
            <details className="disclosure">
              <summary>Backup as a link or QR image</summary>
              <div className="disclosure-body">
                <BackupLinkSection />
              </div>
            </details>
            <input
              ref={restoreInputRef}
              type="file"
              accept=".zip,.yaml,.yml,image/*"
              style={{ display: 'none' }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void openFile(file);
              }}
            />
          </section>

          <section className="card stack tight">
            <SectionTitle>Sync &amp; relays</SectionTitle>
            <p className="tiny faint">
              Interchangeable, self-hostable servers that only ever store encrypted data.
              Inventories can sync through several at once; any single reachable relay is enough.
            </p>
            <RelaysSection />
          </section>

          <section className="card stack tight">
            <SectionTitle>AI</SectionTitle>
            <div className="row between">
              <div className="grow">
                <div className="tiny faint">Claude API key (this device only)</div>
                <div className="small">{aiKeyMasked ?? 'Not set — AI autofill disabled'}</div>
              </div>
              <button type="button" className="link-btn" onClick={() => setAiKeyModal(true)}>
                {aiKeyMasked ? 'Change' : 'Add key'}
              </button>
            </div>
            <p className="tiny faint">
              Powers photo autofill and AI-written selling copy. Optional; everything else works
              without it.
            </p>
          </section>

          <UpdateSection />

          <section className="card stack tight">
            <SectionTitle>This device</SectionTitle>
            <button type="button" className="btn danger" onClick={() => setConfirmLeave(true)}>
              Leave account on this device…
            </button>
            <p className="tiny faint">
              Deletes every inventory, photo and access token from this phone only. Your other
              devices keep everything.
            </p>
          </section>
        </div>
      </main>

      {linkModal ? <LinkDeviceModal onClose={() => setLinkModal(false)} /> : null}

      {confirmLeave ? (
        <ConfirmModal
          title="Leave account on this device?"
          body={`This device will leave the account and delete its ${handles.length} inventor${handles.length === 1 ? 'y' : 'ies'}, photos and access tokens from this phone. Your other devices keep everything. To come back later, scan the device-link code from one of them.`}
          confirmLabel="Leave account"
          destructive
          onClose={() => setConfirmLeave(false)}
          onConfirm={() => {
            toast('Leaving…');
            unlinkDevice()
              .then(() => {
                toast('This device left the account');
                navigate('/', { replace: true });
              })
              .catch((err: unknown) =>
                toastError(err instanceof Error ? err.message : 'Could not leave the account'),
              );
          }}
        />
      ) : null}

      {aiKeyModal ? (
        <AiKeyModal
          hasKey={aiKeyMasked !== null}
          onClose={() => setAiKeyModal(false)}
          onSave={(key) => {
            services.setAiKey(key);
            setAiKeyMasked(services.maskedAiKey());
            setAiKeyModal(false);
            toast(key ? 'API key saved on this device' : 'API key removed');
          }}
        />
      ) : null}

      {nameModal ? (
        <NameModal
          welcome={false}
          initialValue={userName ?? ''}
          onClose={() => setNameModal(false)}
          onSave={(name) => {
            services.setUserName(name);
            setUserNameState(name);
            setNameModal(false);
            toast('Name saved');
          }}
        />
      ) : null}

      {importModals}
    </>
  );
}

/** Subtle live status of the profile (device group) sync. */
function ProfileSyncStatus() {
  const status = useSyncExternalStore(subscribeProfileStatus, getProfileStatus);
  const label =
    status === 'synced'
      ? 'devices in sync'
      : status === 'connecting'
        ? 'linking…'
        : status === 'error'
          ? 'device link error'
          : 'offline';
  return <span className="faint">{label}</span>;
}

/**
 * The DEVICE LINK: a tiny, camera-friendly QR. It carries access to the
 * account, not the data itself — everything arrives via profile sync.
 */
function LinkDeviceModal({ onClose }: { onClose: () => void }) {
  const { toast, toastError } = useToast();
  const { saveFile } = useFileSaver();
  const [linkPayload] = useState(() => services.encodeLinkToken());
  const linkUrl = buildBackupUrl(linkPayload);

  const copy = async () => {
    if (await copyToClipboard(linkUrl)) toast('Link copied');
    else toastError('Clipboard unavailable — long-press the link to copy it');
  };

  const shareQrImage = async () => {
    try {
      const dataUrl = await QRCode.toDataURL(linkUrl, {
        width: 640,
        margin: 2,
        errorCorrectionLevel: 'Q',
        color: { dark: '#0b0e11', light: '#ffffff' },
      });
      const filename = `peerventory-device-link-${new Date().toISOString().slice(0, 10)}.png`;
      await saveFile(dataUrlToBlob(dataUrl), filename, 'QR image');
    } catch {
      toastError('Could not render the QR image');
    }
  };

  return (
    <Modal
      title="Link another device"
      onClose={onClose}
      footer={
        <button type="button" className="btn grow" onClick={onClose}>
          Done
        </button>
      }
    >
      <p className="small muted">
        Scan this with Open / Scan on your other device: it joins your account and every inventory
        follows through sync — including the ones you add later. To share a single inventory with
        someone else, use Share inside that inventory instead.
      </p>
      <QrCanvas value={linkUrl} size={308} ecc="Q" />
      <div className="row" style={{ justifyContent: 'center' }}>
        <button type="button" className="link-btn" onClick={() => void copy()}>
          Copy link
        </button>
        <button type="button" className="link-btn" onClick={() => void shareQrImage()}>
          Share QR image
        </button>
      </div>
      <p className="tiny faint">
        The code carries access to your account, not the data itself. Anyone holding it gets
        everything you have — treat it like a password.
      </p>
    </Modal>
  );
}

/**
 * The FULL BACKUP LINK: every inventory token in one payload — access only,
 * so the contents are pulled from a relay afterwards. For archiving alongside
 * the ZIP and for connecting the browser extension.
 */
function BackupLinkSection() {
  const { toast, toastError } = useToast();
  const { saveFile } = useFileSaver();
  const [backupPayload] = useState(() => services.encodeBackup());
  const backupUrl = buildBackupUrl(backupPayload);

  const copy = async () => {
    if (await copyToClipboard(backupUrl)) toast('Full backup link copied');
    else toastError('Clipboard unavailable — long-press the link to copy it');
  };

  const shareQrImage = async () => {
    try {
      const dataUrl = await QRCode.toDataURL(backupUrl, {
        // A saved image is decoded from clean pixels, not through a camera,
        // so the dense full backup survives here even though it cannot be
        // scanned off a screen.
        width: 1280,
        margin: 2,
        errorCorrectionLevel: 'M',
        color: { dark: '#0b0e11', light: '#ffffff' },
      });
      const filename = `peerventory-full-backup-${new Date().toISOString().slice(0, 10)}.png`;
      await saveFile(dataUrlToBlob(dataUrl), filename, 'QR image');
    } catch {
      toastError('This backup is too large for a QR code — use the link instead');
    }
  };

  return (
    <div className="stack tight">
      <p className="tiny faint">
        Every inventory token in one link — access only, so restoring from it needs a reachable
        relay to pull the data back. For archiving alongside the ZIP and for connecting the
        browser extension. Far too dense to scan off a screen, so use the link — or the saved
        image, which decodes from clean pixels.
      </p>
      <div className="row wrap">
        <button type="button" className="link-btn" onClick={() => void copy()}>
          Copy full backup link
        </button>
        <button type="button" className="link-btn" onClick={() => void shareQrImage()}>
          Share full backup image
        </button>
      </div>
    </div>
  );
}
