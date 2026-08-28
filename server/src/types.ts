/**
 * Path categorization utilities.
 *
 * Vendored (and trimmed) from src/lib/import/types.ts: the same extension
 * tables and categorization rules the browser-side import pipeline uses,
 * adapted to work over plain filesystem paths instead of browser File
 * objects, since this runs as a plain Node process with no bundler/alias
 * resolution back into the frontend's $lib tree.
 */

export interface FileEntry {
  /** Path relative to the library root, forward-slash separated. */
  path: string;
  /** Size in bytes. */
  size: number;
}

export interface CategorizedFile extends FileEntry {
  category: 'mokuro' | 'image' | 'other';
  parentDir: string;
  filename: string;
  stem: string;
  extension: string;
}

export const IMAGE_MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  jxl: 'image/jxl'
};

export const IMAGE_EXTENSIONS = new Set(Object.keys(IMAGE_MIME_TYPES));

export const EXCLUDED_SYSTEM_PATTERNS = new Set([
  '__MACOSX',
  '.DS_Store',
  '.Trashes',
  '.Spotlight-V100',
  '.fseventsd',
  '.TemporaryItems',
  '.Trash',
  'System Volume Information',
  '$RECYCLE.BIN',
  'Thumbs.db',
  'desktop.ini',
  'Desktop.ini',
  'RECYCLER',
  'RECYCLED',
  '.Trash-1000',
  '.thumbnails',
  '.directory',
  '.dropbox',
  '.dropbox.cache',
  '.git',
  '.svn'
]);

const EXCLUDED_EXTENSIONS = new Set(['bak', 'tmp', 'temp']);

export function isSystemFile(path: string): boolean {
  const normalizedPath = path.replace(/\\/g, '/');
  const segments = normalizedPath.split('/');

  for (const segment of segments) {
    if (!segment) continue;
    if (segment.startsWith('._')) return true;
    if (segment.endsWith('~')) return true;
    if (EXCLUDED_SYSTEM_PATTERNS.has(segment)) return true;
  }

  const filename = segments[segments.length - 1] || '';
  const lastDot = filename.lastIndexOf('.');
  if (lastDot >= 0) {
    const ext = filename.slice(lastDot + 1).toLowerCase();
    if (EXCLUDED_EXTENSIONS.has(ext)) return true;
  }

  return false;
}

export function isImageExtension(ext: string): boolean {
  return IMAGE_EXTENSIONS.has(ext.toLowerCase());
}

export function getImageMimeType(ext: string): string {
  return IMAGE_MIME_TYPES[ext.toLowerCase()] || 'application/octet-stream';
}

export function isMokuroExtension(ext: string): boolean {
  return ext.toLowerCase() === 'mokuro';
}

export function parseFilePath(path: string): {
  parentDir: string;
  filename: string;
  stem: string;
  extension: string;
} {
  const normalizedPath = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const lastSlash = normalizedPath.lastIndexOf('/');
  const filename = lastSlash >= 0 ? normalizedPath.slice(lastSlash + 1) : normalizedPath;
  const parentDir = lastSlash >= 0 ? normalizedPath.slice(0, lastSlash) : '';
  const lastDot = filename.lastIndexOf('.');
  const extension = lastDot >= 0 ? filename.slice(lastDot + 1).toLowerCase() : '';
  const stem = lastDot > 0 ? filename.slice(0, lastDot) : filename;

  return { parentDir, filename, stem, extension };
}

export function categorizeFile(entry: FileEntry): CategorizedFile {
  const parsed = parseFilePath(entry.path);

  let category: CategorizedFile['category'];
  if (isMokuroExtension(parsed.extension)) {
    category = 'mokuro';
  } else if (isImageExtension(parsed.extension)) {
    category = 'image';
  } else {
    category = 'other';
  }

  return {
    ...entry,
    category,
    ...parsed
  };
}
