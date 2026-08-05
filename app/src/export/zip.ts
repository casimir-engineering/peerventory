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

/**
 * Writes one inventory (YAML manifest + every photo we hold + the photo
 * index) into `folder` of an open archive. Shared by the per-inventory ZIP
 * export and the full-account backup, so both produce the same layout and
 * the importer only has to understand one.
 */
export async function addInventoryToZip(
  zip: JSZip,
  folder: string,
  snap: InventorySnapshot,
  getPhotoBlob: (hash: string) => Promise<Blob | null>,
): Promise<{ photos: number }> {
  const prefix = folder ? `${folder.replace(/\/$/, '')}/` : '';
  zip.file(`${prefix}inventory.yaml`, inventoryToYaml(snap));

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
        zip.file(prefix + path, blob);
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
  zip.file(`${prefix}photo-index.yaml`, stringify(photoIndex, { lineWidth: 100 }));

  return { photos: availablePhotoPaths.size };
}

export function generateZip(zip: JSZip): Promise<Blob> {
  return zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

export async function inventoryToZip(
  snap: InventorySnapshot,
  getPhotoBlob: (hash: string) => Promise<Blob | null>,
): Promise<Blob> {
  const zip = new JSZip();
  const manifestPromise = inventoryToXlsx(snap);
  await addInventoryToZip(zip, '', snap, getPhotoBlob);
  zip.file('manifest.xlsx', await manifestPromise);
  return generateZip(zip);
}
