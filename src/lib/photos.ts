import imageCompression from 'browser-image-compression';
import { supabase } from '@/lib/supabase';

/** Public Supabase Storage bucket where housekeeping-issue photos live. */
const ISSUES_BUCKET = 'housekeeping-issues';

/** Public Supabase Storage bucket where the mülk photo lives. */
const PROPERTY_PHOTOS_BUCKET = 'property-photos';

/** A mülk carries exactly one photo (DB CHECK enforces the same, migration 128). */
export const PROPERTY_PHOTO_MAX = 1;

/** A sorun carries at most one photo (DB CHECK enforces the same, migration 128). */
export const ISSUE_PHOTO_MAX = 1;

const COMPRESSION_OPTS = {
  maxSizeMB: 0.2, // ~200 KB ceiling per CLAUDE.md free-tier mitigation
  maxWidthOrHeight: 1280,
  useWebWorker: true,
} as const;

/** Shared upload helper — compresses and uploads to the given public bucket. */
async function uploadToBucket(bucket: string, file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Yalnızca görsel dosyaları yüklenebilir.');
  }
  const compressed = await imageCompression(file, COMPRESSION_OPTS);
  const ext = (compressed.type.split('/')[1] ?? 'jpg').toLowerCase();
  const path = `${crypto.randomUUID()}.${ext}`;

  const { error } = await supabase.storage.from(bucket).upload(path, compressed, {
    contentType: compressed.type,
    upsert: false,
  });
  if (error) throw new Error(`Fotoğraf yüklenemedi — ${error.message}`);
  return path;
}

/**
 * Compress an image (~200 KB JPEG, max 1280px) and upload it to the
 * housekeeping-issues bucket. Returns the storage path that the caller
 * should persist in `housekeeping_issues.photo_paths`.
 */
export async function uploadIssuePhoto(file: File): Promise<string> {
  return uploadToBucket(ISSUES_BUCKET, file);
}

/** Build a public URL for an issue photo by its stored path. */
export function issuePhotoUrl(path: string): string {
  const { data } = supabase.storage.from(ISSUES_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

/**
 * Best-effort cleanup of stored issue photos. Used when deleting an issue
 * so we don't leave orphan files in the bucket. Failures are logged and
 * swallowed — the caller can still proceed with the row delete.
 */
export async function deleteIssuePhotos(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const { error } = await supabase.storage.from(ISSUES_BUCKET).remove(paths);
  if (error) {
    console.warn('Sorun fotoğrafları silinemedi:', error.message);
  }
}

/**
 * Compress an image and upload it to the property-photos bucket.
 * Returns the storage path that the caller persists in
 * `properties.photo_paths`.
 */
export async function uploadPropertyPhoto(file: File): Promise<string> {
  return uploadToBucket(PROPERTY_PHOTOS_BUCKET, file);
}

/** Build a public URL for a property photo by its stored path. */
export function propertyPhotoUrl(path: string): string {
  const { data } = supabase.storage.from(PROPERTY_PHOTOS_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

/** Best-effort cleanup of property photos. Failures are logged, not thrown. */
export async function deletePropertyPhotos(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const { error } = await supabase.storage.from(PROPERTY_PHOTOS_BUCKET).remove(paths);
  if (error) {
    console.warn('Mülk fotoğrafları silinemedi:', error.message);
  }
}

