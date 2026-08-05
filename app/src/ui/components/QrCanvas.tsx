import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

/**
 * QR is the offline handoff path: a customs officer scans the screen rather
 * than typing a URL. Short payloads get the stronger error correction, which
 * costs a few modules and buys tolerance for glare and moiré when one phone
 * reads the code off another phone's screen.
 */
export function QrCanvas({
  value,
  size = 232,
  ecc = 'M',
}: {
  value: string;
  size?: number;
  ecc?: 'L' | 'M' | 'Q' | 'H';
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let cancelled = false;
    QRCode.toCanvas(canvas, value, {
      width: size,
      margin: 1,
      errorCorrectionLevel: ecc,
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
  }, [value, size, ecc]);

  if (error) {
    return <p className="small muted">QR code unavailable for this link: {error}</p>;
  }

  return (
    <div className="qr-wrap">
      <canvas ref={ref} width={size} height={size} />
    </div>
  );
}
