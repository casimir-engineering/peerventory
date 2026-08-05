/**
 * Dedicated camera-scan page (scan.html), opened in a chrome-extension:// tab
 * because MV3 popups cannot hold the camera permission prompt. Decodes the
 * profile QR with the same loop the app's QrScanner uses and funnels the
 * result through the shared import path, then tells the user to reopen the
 * popup. Also accepts a dropped/uploaded QR image as a fallback.
 */

import { connectedMessage, importProfileText } from './onboard';
import { decodeQrImage, startCameraScan, type CameraScanner } from './qr';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

let scanner: CameraScanner | null = null;
let done = false;

function setStatus(text: string, kind?: 'ok' | 'err'): void {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

async function handleText(text: string): Promise<void> {
  if (done) return;
  const result = await importProfileText(text);
  if (!result.ok) {
    setStatus(
      result.reason === 'not-a-link'
        ? 'That QR is not a Peerventory profile code — scan the backup QR from the app.'
        : result.reason === 'link-token'
          ? 'That is the app\u2019s device-link code: it links phones, but carries no inventories. Use "Copy full backup link" in the app and paste it here.'
          : 'Could not read the profile payload from that QR.',
      'err',
    );
    return;
  }
  done = true;
  scanner?.stop();
  $('video-wrap').hidden = true;
  $('done').hidden = false;
  setStatus(connectedMessage(result), 'ok');
}

async function start(): Promise<void> {
  scanner = await startCameraScan(
    $<HTMLVideoElement>('video'),
    (text) => void handleText(text),
    (message) => {
      setStatus(message + ' You can still drop a QR image below.', 'err');
    },
  );
}

$('file-btn').addEventListener('click', () => $<HTMLInputElement>('file').click());
$('file').addEventListener('change', async () => {
  const input = $<HTMLInputElement>('file');
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const text = await decodeQrImage(file);
  if (!text) setStatus('No QR code found in that image.', 'err');
  else await handleText(text);
});

document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = Array.from(e.dataTransfer?.files ?? []).find((f) => f.type.startsWith('image/'));
  if (!file) return;
  const text = await decodeQrImage(file);
  if (!text) setStatus('No QR code found in that image.', 'err');
  else await handleText(text);
});

window.addEventListener('unload', () => scanner?.stop());

void start();
