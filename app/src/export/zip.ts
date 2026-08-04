import JSZip from 'jszip';
import { stringify } from 'yaml';

import type { InventorySnapshot } from '../types';
import { inventoryToXlsx } from './xlsx';
import { inventoryToYaml } from './yaml';

function extensionForMime(mime: string): string {
  switch (mime.toLowerCase().split(';', 1)[0].trim()) {
    case 'image/jpeg':
    case 'image/jpg':
    case 'jpeg':
    case 'jpg':
      return 'jpg';
    case 'image/png':
    case 'png':
      return 'png';
    case 'image/webp':
    case 'webp':
      return 'webp';
    default:
      return 'bin';
  }
}

export async function inventoryToZip(
  snap: InventorySnapshot,
  getPhotoBlob: (hash: string) => Promise<Blob | null>,
): Promise<Blob> {
  const zip = new JSZip();
  zip.file('inventory.yaml', inventoryToYaml(snap));

  const manifestPromise = inventoryToXlsx(snap);
  const uniquePhotos = new Map<string, string>();
  for (const item of snap.items) {
    for (const photo of item.photos) {
      if (!uniquePhotos.has(photo.hash)) {
        uniquePhotos.set(photo.hash, `photos/${photo.hash}.${extensionForMime(photo.mime)}`);
      }
    }
  }

  const availablePhotoPaths = new Map<string, string>();
  await Promise.all(
    [...uniquePhotos.entries()].map(async ([hash, path]) => {
      const blob = await getPhotoBlob(hash);
      if (blob) {
        zip.file(path, blob);
        availablePhotoPaths.set(hash, path);
      }
    }),
  );

  const photoIndex = Object.fromEntries(
    snap.items.map((item) => [
      item.id,
      item.photos.flatMap((photo) => {
        const file = availablePhotoPaths.get(photo.hash);
        return file ? [{ file, role: photo.role }] : [];
      }),
    ]),
  );
  zip.file('photo-index.yaml', stringify(photoIndex, { lineWidth: 100 }));
  zip.file('manifest.xlsx', await manifestPromise);

  return zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}
