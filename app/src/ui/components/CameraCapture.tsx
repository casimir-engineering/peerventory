/**
 * Webcam capture for browsers. A phone's file input already opens the OS
 * camera chooser, so this exists for the desktop web app, where the file
 * input is the only photo path and there is no camera in it.
 *
 * The plumbing (getUserMedia constraints, permission errors, track teardown)
 * mirrors QrScanner; this one grabs a still frame instead of decoding.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Capacitor } from '@capacitor/core';

import type { PhotoRole } from '../../types';
import { Modal } from './Modal';
import { TwoStepDeleteButton } from './TwoStepDelete';

const ROLE_TITLE: Record<PhotoRole, string> = {
  photo: 'Take a photo',
  serial_label: 'Photograph the serial label',
  receipt: 'Photograph the receipt',
};

/**
 * Native Android keeps its single button: the OS chooser already offers the
 * camera there, and a second in-app camera would only be in the way.
 */
export function cameraCaptureSupported(): boolean {
  if (Capacitor.isNativePlatform()) return false;
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
}

export function CameraGlyph() {
  return (
    <svg className="camera-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M9 4h6l1.2 2H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.8L9 4Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

interface Shot {
  key: string;
  url: string;
  file: File;
}

function CameraCaptureModal({
  role,
  onCapture,
  onClose,
}: {
  role: PhotoRole;
  onCapture: (files: File[]) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const shotsRef = useRef<Shot[]>([]);
  const [shots, setShots] = useState<Shot[]>([]);
  shotsRef.current = shots;
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Camera access is not available in this browser.');
        return;
      }
      setReady(false);
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: deviceId
            ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
            : { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
      } catch (err) {
        const name = err instanceof DOMException ? err.name : '';
        setError(
          name === 'NotAllowedError'
            ? 'Camera permission was denied. Allow camera access and try again.'
            : name === 'NotFoundError'
              ? 'No camera found on this device.'
              : 'Could not start the camera.',
        );
        return;
      }
      if (stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play().catch(() => {});
      setError(null);
      setReady(true);

      // Labels only exist once permission is granted, so the picker is built
      // after the first stream rather than on mount.
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        if (!stopped) setDevices(all.filter((d) => d.kind === 'videoinput'));
      } catch {
        /* the picker is optional */
      }
    }

    void start();
    return () => {
      stopped = true;
      stream?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [deviceId]);

  // Every preview URL dies with the modal, handed over or not: the receiving
  // side makes its own URL from the File it was given.
  useEffect(
    () => () => {
      for (const shot of shotsRef.current) URL.revokeObjectURL(shot.url);
    },
    [],
  );

  const shutter = async () => {
    const video = videoRef.current;
    if (!video || busy || video.videoWidth === 0) return;
    setBusy(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d')?.drawImage(video, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.92),
      );
      if (!blob) {
        setError('The frame could not be captured.');
        return;
      }
      const stamp = Date.now();
      const file = new File([blob], `capture-${stamp}.jpg`, { type: 'image/jpeg' });
      setShots((prev) => [
        ...prev,
        { key: `${stamp}-${prev.length}`, url: URL.createObjectURL(file), file },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const removeShot = (key: string) => {
    setShots((prev) => {
      const target = prev.find((s) => s.key === key);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((s) => s.key !== key);
    });
  };

  const done = () => {
    if (shots.length > 0) onCapture(shots.map((s) => s.file));
    onClose();
  };

  return (
    <Modal
      title={ROLE_TITLE[role]}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn grow" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary grow"
            disabled={shots.length === 0}
            onClick={done}
          >
            {shots.length > 0 ? `Add ${shots.length} photo${shots.length === 1 ? '' : 's'}` : 'Add'}
          </button>
        </>
      }
    >
      {error ? (
        <p className="small muted">{error}</p>
      ) : (
        <>
          <div className="camera-view">
            {/* muted+playsInline keep autoplay working in every WebView */}
            <video ref={videoRef} muted playsInline />
            {!ready ? <span className="camera-hint">Starting the camera…</span> : null}
          </div>

          <button
            type="button"
            className="btn primary block camera-shutter"
            disabled={!ready || busy}
            onClick={() => void shutter()}
          >
            Capture
          </button>

          {devices.length > 1 ? (
            <select
              className="select"
              aria-label="Camera"
              value={deviceId ?? devices[0]?.deviceId ?? ''}
              onChange={(e) => setDeviceId(e.target.value)}
            >
              {devices.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Camera ${index + 1}`}
                </option>
              ))}
            </select>
          ) : null}

          {shots.length > 0 ? (
            <div className="gallery">
              {shots.map((shot) => (
                <div className="gallery-item" key={shot.key}>
                  <img className="gallery-photo" src={shot.url} alt="Captured photo" />
                  <TwoStepDeleteButton
                    className="remove"
                    label="Discard this capture"
                    onDelete={() => removeShot(shot.key)}
                  >
                    ✕
                  </TwoStepDeleteButton>
                </div>
              ))}
            </div>
          ) : (
            <p className="tiny faint">
              Capture as many shots as you need; they are added when you close this window.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}

/** Opens the webcam modal. Renders nothing where the webcam path does not apply. */
export function CameraButton({
  role = 'photo',
  onFiles,
  className = 'btn sm',
  disabled,
  ariaLabel,
  children,
}: {
  role?: PhotoRole;
  onFiles: (files: File[]) => void;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (!cameraCaptureSupported()) return null;
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={disabled}
        aria-label={ariaLabel}
        title={ariaLabel}
        onClick={() => setOpen(true)}
      >
        {children}
      </button>
      {open ? (
        <CameraCaptureModal role={role} onCapture={onFiles} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}
