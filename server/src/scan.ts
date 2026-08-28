/**
 * Walks the mounted library directory and builds a LibraryIndex.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FileEntry } from './types.js';
import { isSystemFile } from './types.js';
import { pairMokuroWithSources, type PairedSource } from './pairing.js';
import { matchImagesToPages } from './image-match.js';
import { extractTitlesFromPath, extractSeriesName, generateDeterministicUUID } from './series-extraction.js';
import { naturalSort } from './natural-sort.js';
import type { LibraryIndex, VolumeIndexEntry, MokuroPageEntry } from './library-index.js';

const MOKURO_REQUIRED_FIELDS = ['version', 'title', 'title_uuid', 'volume', 'volume_uuid', 'pages'];

interface ParsedMokuro {
  version: string;
  title: string;
  titleUuid: string;
  volume: string;
  volumeUuid: string;
  pages: MokuroPageEntry[];
  chars: number;
  spineWidth?: number;
}

async function walk(root: string, dir = '.'): Promise<FileEntry[]> {
  const absDir = path.join(root, dir);
  let dirents;
  try {
    dirents = await readdir(absDir, { withFileTypes: true });
  } catch (err) {
    // Root (or a subdirectory encountered mid-walk, e.g. removed concurrently) unreadable — treat as empty.
    console.warn(`[library-server] could not read directory ${absDir}:`, (err as Error).message);
    return [];
  }

  const entries: FileEntry[] = [];

  for (const dirent of dirents) {
    const relPath = dir === '.' ? dirent.name : `${dir}/${dirent.name}`;
    if (isSystemFile(relPath)) continue;

    if (dirent.isDirectory()) {
      const nested = await walk(root, relPath);
      entries.push(...nested);
    } else if (dirent.isFile()) {
      try {
        const st = await stat(path.join(root, relPath));
        entries.push({ path: relPath, size: st.size });
      } catch (err) {
        console.warn(`[library-server] could not stat ${relPath}:`, (err as Error).message);
      }
    }
    // symlinks and other special files are intentionally skipped
  }

  return entries;
}

function parseMokuroContent(raw: string, sourcePath: string): ParsedMokuro {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`${sourcePath}: not valid JSON`);
  }

  const obj = data as Record<string, unknown>;
  const missingFields = MOKURO_REQUIRED_FIELDS.filter((field) => !(field in obj));
  if (missingFields.length > 0) {
    throw new Error(`${sourcePath}: missing required fields: ${missingFields.join(', ')}`);
  }

  return {
    version: obj.version as string,
    title: obj.title as string,
    titleUuid: obj.title_uuid as string,
    volume: obj.volume as string,
    volumeUuid: obj.volume_uuid as string,
    pages: obj.pages as MokuroPageEntry[],
    chars: (obj.chars as number) ?? 0,
    ...(obj.spine_width != null && { spineWidth: obj.spine_width as number })
  };
}

function countBlockChars(block: unknown): number {
  const b = block as { lines?: unknown };
  if (!b.lines || !Array.isArray(b.lines)) return 0;
  return b.lines.reduce((sum: number, line) => sum + (typeof line === 'string' ? line.length : 0), 0);
}

function cumulativeChars(pages: MokuroPageEntry[]): number[] {
  const counts: number[] = [];
  let cumulative = 0;
  for (const page of pages) {
    const blocks = Array.isArray(page.blocks) ? page.blocks : [];
    cumulative += blocks.reduce((sum: number, block) => sum + countBlockChars(block), 0);
    counts.push(cumulative);
  }
  return counts;
}

function pickCoverImgPath(pages: MokuroPageEntry[], imageFiles: Map<string, string>): string | null {
  const withImage = pages.filter((p) => imageFiles.has(p.img_path));
  const cover = withImage.find((p) => p.img_path.toLowerCase().includes('cover'));
  if (cover) return cover.img_path;
  if (withImage.length > 0) return withImage[0].img_path;
  const first = imageFiles.keys().next();
  return first.done ? null : first.value;
}

function flattenDirectoryFiles(source: PairedSource): Map<string, string> {
  if (source.source.type === 'directory') {
    return source.source.files;
  }
  // toc-directory: merge chapters, prefixing with the chapter name, mirroring
  // tocDirectoryToDecompressed on the frontend.
  const merged = new Map<string, string>();
  for (const [chapterName, files] of source.source.chapters) {
    for (const [filename, libraryRelPath] of files) {
      merged.set(`${chapterName}/${filename}`, libraryRelPath);
    }
  }
  return merged;
}

async function buildVolumeEntry(
  root: string,
  pairing: PairedSource,
  warnings: string[]
): Promise<VolumeIndexEntry | null> {
  const volumeFiles = flattenDirectoryFiles(pairing);

  if (pairing.mokuroPath) {
    let raw: string;
    try {
      raw = await readFile(path.join(root, pairing.mokuroPath), 'utf-8');
    } catch (err) {
      warnings.push(`Could not read ${pairing.mokuroPath}: ${(err as Error).message}`);
      return null;
    }

    let mokuro: ParsedMokuro;
    try {
      mokuro = parseMokuroContent(raw, pairing.mokuroPath);
    } catch (err) {
      warnings.push((err as Error).message);
      return null;
    }

    const matchResult = matchImagesToPages(mokuro.pages, volumeFiles);
    const imageFiles = new Map<string, string>();
    for (const [imgPath, libraryRelPath] of matchResult.matchedFiles) {
      imageFiles.set(imgPath, path.join(root, libraryRelPath));
    }

    const pageCharCounts = cumulativeChars(mokuro.pages);

    return {
      volumeUuid: mokuro.volumeUuid,
      seriesUuid: mokuro.titleUuid,
      seriesTitle: mokuro.title,
      volumeTitle: mokuro.volume,
      mokuroVersion: mokuro.version,
      pageCount: mokuro.pages.length,
      characterCount: mokuro.chars || pageCharCounts[pageCharCounts.length - 1] || 0,
      pageCharCounts,
      missingPages: matchResult.missing.length,
      missingPagePaths: matchResult.missing,
      spineWidth: mokuro.spineWidth,
      coverImgPath: pickCoverImgPath(mokuro.pages, imageFiles),
      pages: mokuro.pages,
      imageFiles
    };
  }

  // Image-only volume: no .mokuro file anywhere near these images.
  const sortedRelPaths = Array.from(volumeFiles.keys()).sort(naturalSort);
  if (sortedRelPaths.length === 0) return null;

  const imageFiles = new Map<string, string>();
  const pages: MokuroPageEntry[] = sortedRelPaths.map((relPath) => {
    imageFiles.set(relPath, path.join(root, volumeFiles.get(relPath)!));
    return { img_path: relPath, img_width: 1000, img_height: 1400, blocks: [] };
  });

  const { seriesTitle, volumeTitle } = extractTitlesFromPath(pairing.basePath);
  const seriesName = extractSeriesName(pairing.basePath);
  const seriesUuid = generateDeterministicUUID(seriesName);
  const volumeUuid = generateDeterministicUUID(`${seriesName}/${volumeTitle}`);

  return {
    volumeUuid,
    seriesUuid,
    seriesTitle,
    volumeTitle,
    mokuroVersion: '',
    pageCount: pages.length,
    characterCount: 0,
    pageCharCounts: pages.map(() => 0),
    missingPages: 0,
    missingPagePaths: [],
    coverImgPath: pickCoverImgPath(pages, imageFiles),
    pages,
    imageFiles
  };
}

export async function scanLibrary(root: string): Promise<LibraryIndex> {
  const startedAt = Date.now();
  const entries = await walk(root);
  const { pairings, warnings } = pairMokuroWithSources(entries);

  const volumes = new Map<string, VolumeIndexEntry>();

  for (const pairing of pairings) {
    const entry = await buildVolumeEntry(root, pairing, warnings);
    if (!entry) continue;

    if (volumes.has(entry.volumeUuid)) {
      warnings.push(
        `Duplicate volume_uuid ${entry.volumeUuid} (${entry.seriesTitle} / ${entry.volumeTitle}) — keeping the first one found, ignoring the rest`
      );
      continue;
    }

    volumes.set(entry.volumeUuid, entry);
  }

  console.log(
    `[library-server] scanned ${root}: ${volumes.size} volume(s), ${warnings.length} warning(s) in ${Date.now() - startedAt}ms`
  );
  for (const warning of warnings) {
    console.warn(`[library-server] ${warning}`);
  }

  return { volumes, scannedAt: new Date().toISOString(), warnings };
}
