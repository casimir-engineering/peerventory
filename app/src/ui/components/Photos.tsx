import { useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { usePhotoUrl } from '../../store';
import type { Id, PhotoRef, PhotoRole } from '../../types';

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
  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-modal="true" aria-label="Photo">
      <button type="button" className="btn ghost icon close" onClick={onClose} aria-label="Close">
        ✕
      </button>
      {url ? <img src={url} alt="Item photo" /> : <span className="muted">Photo not downloaded yet</span>}
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
