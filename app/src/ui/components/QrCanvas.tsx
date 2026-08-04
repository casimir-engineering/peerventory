import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

/**
 * QR is the offline handoff path: a customs officer scans the screen rather
 * than typing a URL, so error correction is kept high.
 */
export function QrCanvas({ value, size = 232 }: { value: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let cancelled = false;
    QRCode.toCanvas(canvas, value, {
      width: size,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0b0e11', light: '#ffffff' },
    })
      .then(() => {
        if (!cancelled) setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'QR code failed');
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (error) {
    return <p className="small muted">QR code unavailable for this link: {error}</p>;
  }

  return (
    <div className="qr-wrap">
      <canvas ref={ref} width={size} height={size} />
    </div>
  );
}
