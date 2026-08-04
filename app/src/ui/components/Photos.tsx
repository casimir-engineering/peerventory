import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { usePhotoUrl } from '../../store';
import type { Id, PhotoRef, PhotoRole } from '../../types';
import { useModalDismiss } from './Modal';

const ROLE_LABEL: Record<PhotoRole, string> = {
  photo: 'Photo',
  serial_label: 'Serial label',
  receipt: 'Receipt',
};

/** Renders a stored blob; shows a placeholder while it downloads (or offline). */
export function PhotoImage({
  docId,
  hash,
  alt,
  className = 'thumb',
  onClick,
}: {
  docId: Id;
  hash: string | null;
  alt: string;
  className?: string;
  onClick?: () => void;
}) {
  const url: string | null = usePhotoUrl(docId, hash);
  if (!url) {
    return (
      <div className={`${className} thumb-empty`} onClick={onClick} aria-label={alt}>
        {hash ? 'Loading' : 'No photo'}
      </div>
    );
  }
  return <img className={className} src={url} alt={alt} loading="lazy" onClick={onClick} />;
}

const MIN_SCALE = 1;
const MAX_SCALE = 6;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 40;
const TAP_SLOP_PX = 12;

interface ZoomTransform {
  scale: number;
  tx: number;
  ty: number;
}

/**
 * Fullscreen viewer with pinch-to-zoom, drag-to-pan, double-tap / double-click
 * zoom and wheel zoom. The transform model: the image keeps its natural
 * centered flex layout, and `translate(tx, ty) scale(s)` with
 * transform-origin 0 0 is applied on top, so a point p (in the image's
 * untransformed layout px, from its top-left) lands on screen at
 * layoutTopLeft + (tx, ty) + s * p.
 */
export function PhotoLightbox({
  docId,
  hash,
  onClose,
}: {
  docId: Id;
  hash: string;
  onClose: () => void;
}) {
  const url: string | null = usePhotoUrl(docId, hash);
  // Counts as an open modal: Android back (and Escape) closes the viewer,
  // zoomed or not, instead of navigating.
  useModalDismiss(onClose);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const t = useRef<ZoomTransform>({ scale: 1, tx: 0, ty: 0 });
  // Re-render only when crossing the zoomed/unzoomed boundary (cursor, class,
  // and tap-to-close behavior); per-frame updates go straight to the style.
  const [zoomed, setZoomed] = useState(false);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchStart = useRef<{
    dist: number;
    centroid: { x: number; y: number };
    t: ZoomTransform;
  } | null>(null);
  const dragStart = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const downPos = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  const lastTap = useRef<{ time: number; x: number; y: number } | null>(null);
  const closeTimer = useRef<number | null>(null);

  const apply = (next: ZoomTransform, animate = false) => {
    t.current = next;
    const img = imgRef.current;
    if (img) {
      img.style.transition = animate ? 'transform 0.18s ease-out' : 'none';
      img.style.transform = `translate(${next.tx}px, ${next.ty}px) scale(${next.scale})`;
    }
    setZoomed(next.scale > 1.001);
  };

  /** Untransformed layout rect of the image (current rect minus transform). */
  const baseRect = () => {
    const img = imgRef.current;
    if (!img) return null;
    const r = img.getBoundingClientRect();
    const { scale, tx, ty } = t.current;
    return {
      left: r.left - tx,
      top: r.top - ty,
      width: r.width / scale,
      height: r.height / scale,
    };
  };

  /** Keep the image covering the viewport while zoomed; center any slack axis. */
  const clamp = (next: ZoomTransform): ZoomTransform => {
    const surface = surfaceRef.current;
    const base = baseRect();
    if (!surface || !base) return next;
    const c = surface.getBoundingClientRect();
    const w = base.width * next.scale;
    const h = base.height * next.scale;
    const clampAxis = (tv: number, size: number, cMin: number, cSize: number, bMin: number) => {
      if (size <= cSize) return cMin + (cSize - size) / 2 - bMin;
      return Math.min(cMin - bMin, Math.max(cMin + cSize - size - bMin, tv));
    };
    return {
      scale: next.scale,
      tx: clampAxis(next.tx, w, c.left, c.width, base.left),
      ty: clampAxis(next.ty, h, c.top, c.height, base.top),
    };
  };

  /** Rescale so the image point currently under screen point (cx, cy) stays put. */
  const zoomAt = (cx: number, cy: number, nextScale: number, animate = false) => {
    const base = baseRect();
    if (!base) return;
    const s0 = t.current.scale;
    const s1 = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
    const px = (cx - base.left - t.current.tx) / s0;
    const py = (cy - base.top - t.current.ty) / s0;
    apply(clamp({ scale: s1, tx: cx - base.left - s1 * px, ty: cy - base.top - s1 * py }), animate);
  };

  const reset = (animate = false) => apply({ scale: 1, tx: 0, ty: 0 }, animate);

  // New photo (or late blob download) starts untransformed.
  useEffect(() => {
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, url]);

  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  // React attaches wheel listeners passively, so preventDefault (needed to
  // stop the page behind from scrolling on desktop) requires a manual one.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.002);
      zoomAt(e.clientX, e.clientY, t.current.scale * factor);
    };
    surface.addEventListener('wheel', onWheel, { passive: false });
    return () => surface.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const pinchDist = () => {
    const [a, b] = [...pointers.current.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const pinchCentroid = () => {
    const [a, b] = [...pointers.current.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    surfaceRef.current?.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (imgRef.current) imgRef.current.style.transition = 'none';
    if (pointers.current.size === 2) {
      pinchStart.current = { dist: pinchDist(), centroid: pinchCentroid(), t: { ...t.current } };
      dragStart.current = null;
      moved.current = true; // a pinch is never a tap
    } else if (pointers.current.size === 1) {
      downPos.current = { x: e.clientX, y: e.clientY };
      moved.current = false;
      dragStart.current = { x: e.clientX, y: e.clientY, tx: t.current.tx, ty: t.current.ty };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2 && pinchStart.current) {
      const start = pinchStart.current;
      const dist = pinchDist();
      const centroid = pinchCentroid();
      const base = baseRect();
      if (!base || start.dist === 0) return;
      const s1 = Math.min(MAX_SCALE, Math.max(MIN_SCALE, start.t.scale * (dist / start.dist)));
      // The image point that sat under the starting centroid follows the
      // moving centroid, so pinch and two-finger pan work in one gesture.
      const px = (start.centroid.x - base.left - start.t.tx) / start.t.scale;
      const py = (start.centroid.y - base.top - start.t.ty) / start.t.scale;
      apply(
        clamp({ scale: s1, tx: centroid.x - base.left - s1 * px, ty: centroid.y - base.top - s1 * py }),
      );
      return;
    }

    if (pointers.current.size === 1 && dragStart.current) {
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      if (downPos.current && Math.hypot(dx, dy) > TAP_SLOP_PX) moved.current = true;
      if (t.current.scale > 1.001 && moved.current) {
        apply(
          clamp({
            scale: t.current.scale,
            tx: dragStart.current.tx + dx,
            ty: dragStart.current.ty + dy,
          }),
        );
      }
    }
  };

  const endPointer = (e: React.PointerEvent) => {
    const wasTapCandidate =
      pointers.current.size === 1 && !moved.current && e.type === 'pointerup';
    pointers.current.delete(e.pointerId);

    if (pointers.current.size === 1) {
      // Pinch ended with one finger still down: re-anchor it as a pan.
      const [p] = [...pointers.current.values()];
      pinchStart.current = null;
      dragStart.current = { x: p.x, y: p.y, tx: t.current.tx, ty: t.current.ty };
      return;
    }
    if (pointers.current.size > 0) return;
    pinchStart.current = null;
    dragStart.current = null;
    if (!wasTapCandidate) return;

    const tap = { time: Date.now(), x: e.clientX, y: e.clientY };
    const prev = lastTap.current;
    const isDouble =
      prev !== null &&
      tap.time - prev.time < DOUBLE_TAP_MS &&
      Math.hypot(tap.x - prev.x, tap.y - prev.y) < DOUBLE_TAP_SLOP_PX;

    if (isDouble) {
      lastTap.current = null;
      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
      if (t.current.scale > 1.001) reset(true);
      else zoomAt(tap.x, tap.y, DOUBLE_TAP_SCALE, true);
      return;
    }

    lastTap.current = tap;
    // Single tap closes only while unzoomed, and only after the double-tap
    // window has passed so "double-tap to zoom" never dismisses the viewer.
    if (t.current.scale <= 1.001) {
      closeTimer.current = window.setTimeout(onClose, DOUBLE_TAP_MS);
    }
  };

  return (
    <div
      ref={surfaceRef}
      className={`lightbox${zoomed ? ' zoomed' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Photo"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
    >
      <button type="button" className="btn ghost icon close" onClick={onClose} aria-label="Close">
        ✕
      </button>
      {url ? (
        <img ref={imgRef} src={url} alt="Item photo" draggable={false} />
      ) : (
        <span className="muted">Photo not downloaded yet</span>
      )}
    </div>
  );
}

/** Button that opens the camera (or the picker) and hands back the chosen files. */
export function PhotoPickerButton({
  onFiles,
  capture,
  multiple,
  className = 'photo-add',
  children,
  disabled,
}: {
  onFiles: (files: File[]) => void;
  capture?: boolean;
  multiple?: boolean;
  className?: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length > 0) onFiles(files);
  };

  return (
    <>
      <button
        type="button"
        className={className}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        {children}
      </button>
      <input
        ref={inputRef}
        className="hidden-input"
        type="file"
        accept="image/*"
        {...(capture ? { capture: 'environment' as const } : {})}
        multiple={multiple}
        onChange={handleChange}
        tabIndex={-1}
      />
    </>
  );
}

export function PhotoGallery({
  docId,
  photos,
  readonly,
  busy,
  onAdd,
  onRemove,
}: {
  docId: Id;
  photos: PhotoRef[];
  readonly: boolean;
  busy?: boolean;
  onAdd: (files: File[], role: PhotoRole) => void;
  onRemove: (hash: string) => void;
}) {
  const [lightbox, setLightbox] = useState<string | null>(null);
  const sorted = [...(photos ?? [])].sort((a, b) => a.addedAt - b.addedAt);

  return (
    <div className="stack tight">
      <div className="gallery">
        {sorted.map((photo) => (
          <div className="gallery-item" key={photo.hash}>
            <PhotoImage
              docId={docId}
              hash={photo.hash}
              alt={ROLE_LABEL[photo.role] ?? 'Photo'}
              className="gallery-photo"
              onClick={() => setLightbox(photo.hash)}
            />
            {photo.role !== 'photo' ? (
              <span className="role-badge">{ROLE_LABEL[photo.role]}</span>
            ) : null}
            {!readonly ? (
              <button
                type="button"
                className="remove"
                aria-label="Remove photo"
                onClick={() => onRemove(photo.hash)}
              >
                ✕
              </button>
            ) : null}
          </div>
        ))}

        {!readonly ? (
          <PhotoPickerButton onFiles={(files) => onAdd(files, 'photo')} capture disabled={busy}>
            <span className="glyph" aria-hidden="true">
              +
            </span>
            <span>{busy ? 'Saving' : 'Take photo'}</span>
          </PhotoPickerButton>
        ) : null}

        {sorted.length === 0 && readonly ? (
          <div className="thumb-empty gallery-photo">No photos</div>
        ) : null}
      </div>

      {!readonly ? (
        <div className="row wrap">
          <PhotoPickerButton
            className="btn sm"
            onFiles={(files) => onAdd(files, 'photo')}
            multiple
            disabled={busy}
          >
            Add from gallery
          </PhotoPickerButton>
          <PhotoPickerButton
            className="btn sm"
            onFiles={(files) => onAdd(files, 'serial_label')}
            capture
            disabled={busy}
          >
            Add serial label photo
          </PhotoPickerButton>
          <PhotoPickerButton
            className="btn sm"
            onFiles={(files) => onAdd(files, 'receipt')}
            capture
            disabled={busy}
          >
            Add receipt photo
          </PhotoPickerButton>
        </div>
      ) : null}

      {lightbox ? (
        <PhotoLightbox docId={docId} hash={lightbox} onClose={() => setLightbox(null)} />
      ) : null}
    </div>
  );
}

export { ROLE_LABEL };
