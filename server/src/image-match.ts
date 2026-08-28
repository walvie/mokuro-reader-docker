/**
 * Match mokuro page img_path entries to the image files actually found on
 * disk for a volume. Adapted from matchImagesToPages in
 * src/lib/import/processing.ts, operating on a Map<relativePath, absPath>
 * instead of Map<relativePath, File>.
 */

import { naturalSort } from './natural-sort.js';

export interface MokuroPageLike {
  img_path: string;
}

export interface ImageMatchResult {
  /** page img_path -> absolute filesystem path of the matched image */
  matchedFiles: Map<string, string>;
  missing: string[];
}

function getStem(path: string): string {
  const filename = path.split('/').pop() || path;
  const lastDot = filename.lastIndexOf('.');
  return lastDot > 0 ? filename.slice(0, lastDot) : filename;
}

function normalizePath(path: string): string {
  return path.toLowerCase().replace(/\\/g, '/');
}

export function matchImagesToPages(
  pages: MokuroPageLike[],
  files: Map<string, string>
): ImageMatchResult {
  const matchedFiles = new Map<string, string>();
  const missing: string[] = [];

  const normalizedFiles = new Map<string, string>(); // normalized relPath -> relPath
  const stemFiles = new Map<string, string>(); // stem -> relPath

  for (const relPath of files.keys()) {
    normalizedFiles.set(normalizePath(relPath), relPath);
    stemFiles.set(getStem(relPath).toLowerCase(), relPath);
  }

  const usedRelPaths = new Set<string>();

  for (const page of pages) {
    const pagePath = page.img_path;
    const normalizedPagePath = normalizePath(pagePath);

    if (normalizedFiles.has(normalizedPagePath)) {
      const relPath = normalizedFiles.get(normalizedPagePath)!;
      matchedFiles.set(pagePath, files.get(relPath)!);
      usedRelPaths.add(relPath);
      continue;
    }

    const pageStem = getStem(pagePath).toLowerCase();
    if (stemFiles.has(pageStem)) {
      const relPath = stemFiles.get(pageStem)!;
      if (!usedRelPaths.has(relPath)) {
        matchedFiles.set(pagePath, files.get(relPath)!);
        usedRelPaths.add(relPath);
        continue;
      }
    }

    missing.push(pagePath);
  }

  // Count-based fallback: same as the frontend's matchImagesToPages — if
  // name matching mostly failed but the counts of missing/unused files line
  // up, pair them positionally after a natural sort.
  const extra: string[] = [];
  for (const relPath of files.keys()) {
    if (!usedRelPaths.has(relPath)) {
      extra.push(relPath);
    }
  }

  if (missing.length > 0 && missing.length === extra.length) {
    const matchRatio = matchedFiles.size / pages.length;
    if (matchRatio < 0.5) {
      const sortedMissing = [...missing].sort(naturalSort);
      const sortedExtra = [...extra].sort(naturalSort);

      for (let i = 0; i < sortedMissing.length; i++) {
        matchedFiles.set(sortedMissing[i], files.get(sortedExtra[i])!);
      }
      missing.length = 0;
    }
  }

  return { matchedFiles, missing };
}
