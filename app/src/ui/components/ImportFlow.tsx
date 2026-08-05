/**
 * One entry point for everything the user brings INTO the app:
 *
 *  - scanned or pasted TEXT: inventory share links, device-link / backup
 *    payloads, AI-key QR payloads;
 *  - picked or dropped FILES: single-inventory exports (.zip/.yaml),
 *    full-account backup ZIPs, and QR-code images.
 *
 * Both the home screen (drag & drop, Open / Scan) and the Account & sync
 * page (Restore from file) run through this hook, so the accepted formats
 * and the resulting modals never drift apart between the two.
 */

import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import * as services from '../../services';
import { rememberRelayHint } from '../../store';
import { joinRoute, parseShareLink } from '../lib/links';
import type { ParsedAccount, ParsedImport } from '../lib/importFile';
import { parseImportFile } from '../lib/importFile';
import { decodeQrImage } from '../lib/qrDecode';
import { AccountRestoreModal } from './AccountRestoreModal';
import { ImportModal } from './ImportModal';
import { useToast } from './Toast';

export type OpenOutcome = { ok: true } | { ok: false; reason: string };

export interface ImportFlow {
  /**
   * Text from a QR scan, a paste, or a decoded QR image. Always returns a
   * reason when it refuses: a scanner that silently ignores a code the user
   * is pointing at is indistinguishable from a broken camera.
   */
  openText: (text: string) => OpenOutcome;
  /** A dropped or picked file: data export, account backup, or QR image. */
  openFile: (file: File) => Promise<void>;
  /** Render this once near the end of the page. */
  modals: ReactNode;
}

export function useImportFlow(options?: {
  /** A scanned/pasted code was accepted (e.g. close the scanner modal). */
  onHandled?: () => void;
  /** An AI-key QR installed a key on this device. */
  onAiKeySaved?: () => void;
}): ImportFlow {
  const navigate = useNavigate();
  const { toast, toastError } = useToast();
  const onHandled = options?.onHandled;
  const onAiKeySaved = options?.onAiKeySaved;

  const [importState, setImportState] = useState<{ parsed: ParsedImport; fileName: string } | null>(
    null,
  );
  const [accountRestore, setAccountRestore] = useState<{
    account: ParsedAccount;
    fileName: string;
  } | null>(null);

  const openText = useCallback(
    (text: string): OpenOutcome => {
      const aiKey = services.parseAiKeyQr(text);
      if (aiKey) {
        services.setAiKey(aiKey);
        onAiKeySaved?.();
        onHandled?.();
        toast('Claude API key installed on this device');
        return { ok: true };
      }
      const backupPayload = services.parseBackupText(text);
      if (backupPayload) {
        onHandled?.();
        navigate(`/restore/${backupPayload}`);
        return { ok: true };
      }
      const parsed = parseShareLink(text);
      if (!parsed) {
        return {
          ok: false,
          reason: /^https?:\/\//i.test(text.trim())
            ? 'That is a web link, but not an inventory or device code.'
            : 'That code is not an inventory link or device code.',
        };
      }
      // A pasted/scanned link's origin is a relay hint the join flow records.
      if (parsed.origin) rememberRelayHint(parsed.docId, parsed.origin);
      onHandled?.();
      navigate(joinRoute(parsed));
      return { ok: true };
    },
    [navigate, toast, onHandled, onAiKeySaved],
  );

  const openFile = useCallback(
    async (file: File) => {
      const name = file.name.toLowerCase();
      const isData =
        name.endsWith('.zip') ||
        name.endsWith('.yaml') ||
        name.endsWith('.yml') ||
        file.type === 'application/zip';
      if (isData) {
        try {
          const result = await parseImportFile(file);
          if (result.kind === 'account') {
            setAccountRestore({ account: result.account, fileName: file.name });
          } else {
            setImportState({ parsed: result.parsed, fileName: file.name });
          }
        } catch (err) {
          toastError(err instanceof Error ? err.message : 'Could not read this file');
        }
        return;
      }
      if (file.type.startsWith('image/') || /\.(png|jpe?g|webp)$/.test(name)) {
        const text = await decodeQrImage(file);
        if (!text) {
          toastError('No QR code found in this image');
          return;
        }
        const outcome = openText(text);
        if (!outcome.ok) toastError(outcome.reason);
        return;
      }
      toastError('Drop a .zip or .yaml export, or a QR code image');
    },
    [openText, toastError],
  );

  const modals = (
    <>
      {accountRestore ? (
        <AccountRestoreModal
          account={accountRestore.account}
          fileName={accountRestore.fileName}
          onClose={() => setAccountRestore(null)}
          onRestored={(summary) => {
            setAccountRestore(null);
            toast(summary);
          }}
        />
      ) : null}

      {importState ? (
        <ImportModal
          parsed={importState.parsed}
          fileName={importState.fileName}
          onClose={() => setImportState(null)}
          onImported={(docId) => {
            setImportState(null);
            toast('Inventory imported');
            navigate(`/inv/${docId}`);
          }}
        />
      ) : null}
    </>
  );

  return { openText, openFile, modals };
}
