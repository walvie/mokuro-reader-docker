/**
 * Mokuro-source pairing logic for the library server.
 *
 * Adapted from src/lib/import/pairing.ts: same matching rules (same-directory
 * images, same-name subdirectory matching, TOC-format chapters, image-only
 * fallback), but operating over plain filesystem paths instead of browser
 * File objects, and with the archive-specific passes removed — the library
 * server only reads already-extracted directories from the mounted host
 * path, it does not open .zip/.cbz files found inside the library.
 */

import type { FileEntry, CategorizedFile } from './types.js';
import { categorizeFile, isSystemFile } from './types.js';

export interface DirectorySource {
  type: 'directory';
  /** Map of relative path (within the volume) -> path relative to the library root */
  files: Map<string, string>;
}

export interface TocDirectorySource {
  type: 'toc-directory';
  chapters: Map<string, Map<string, string>>;
}

export type SourceDescriptor = DirectorySource | TocDirectorySource;

export interface PairedSource {
  /** Path (relative to library root) of the external .mokuro file, if any */
  mokuroPath: string | null;
  source: SourceDescriptor;
  /** Base path for series/volume name extraction */
  basePath: string;
  imageOnly: boolean;
}

export interface PairingResult {
  pairings: PairedSource[];
  warnings: string[];
}

export function pairMokuroWithSources(entries: FileEntry[]): PairingResult {
  const filteredEntries = entries.filter((e) => !isSystemFile(e.path));
  const categorized = filteredEntries.map(categorizeFile);

  const mokuroFiles = categorized.filter((f) => f.category === 'mokuro');
  const imageFiles = categorized.filter((f) => f.category === 'image');

  const pairings: PairedSource[] = [];
  const warnings: string[] = [];

  const pairedMokuroPaths = new Set<string>();
  const pairedImageDirs = new Set<string>();

  const dirStructure = buildDirectoryStructure(imageFiles);

  const getUnpairedMokuro = () => mokuroFiles.filter((m) => !pairedMokuroPaths.has(m.path));

  // PASS 1: Same-directory images (mokuro inside folder with images)
  for (const mokuro of getUnpairedMokuro()) {
    const mokuroDir = mokuro.parentDir || '.';
    const sameDirImages = dirStructure.get(mokuroDir);
    if (sameDirImages && sameDirImages.size > 0 && !pairedImageDirs.has(mokuroDir)) {
      pairedImageDirs.add(mokuroDir);
      pairedMokuroPaths.add(mokuro.path);
      pairings.push(createDirectoryPairing(mokuroDir, sameDirImages, mokuro.path, false));
    }
  }

  // PASS 2: Same-name directory matching (including nested subdirectories)
  for (const mokuro of getUnpairedMokuro()) {
    const mokuroStem = mokuro.stem;
    const mokuroParent = mokuro.parentDir || '.';

    const expectedPrefix =
      mokuroParent === '.'
        ? mokuroStem.toLowerCase() + '/'
        : (mokuroParent + '/' + mokuroStem).toLowerCase() + '/';

    const exactMatch =
      mokuroParent === '.'
        ? mokuroStem.toLowerCase()
        : (mokuroParent + '/' + mokuroStem).toLowerCase();

    const matchingDirs: string[] = [];
    for (const [dir] of dirStructure) {
      if (pairedImageDirs.has(dir)) continue;
      const dirLower = dir.toLowerCase();
      if (dirLower === exactMatch || dirLower.startsWith(expectedPrefix)) {
        matchingDirs.push(dir);
      }
    }

    if (matchingDirs.length > 0) {
      const mergedFiles = new Map<string, string>();
      for (const dir of matchingDirs) {
        const files = dirStructure.get(dir)!;
        for (const [filename, fullPath] of files) {
          const relativePath = mokuroParent === '.' ? dir : dir.slice(mokuroParent.length + 1);
          mergedFiles.set(relativePath + '/' + filename, fullPath);
        }
        pairedImageDirs.add(dir);
      }

      if (mergedFiles.size > 0) {
        pairedMokuroPaths.add(mokuro.path);
        // Full path (parent + stem), not just the stem: this doubles as the
        // extraction/lookup key elsewhere, so it must match the images'
        // actual location on disk. See the equivalent fix in the frontend's
        // pairing.ts (PASS 2) for the archive-extraction bug this mirrors.
        const basePath = mokuroParent === '.' ? mokuroStem : mokuroParent + '/' + mokuroStem;
        pairings.push(createDirectoryPairing(basePath, mergedFiles, mokuro.path, false));
      }
    }
  }

  // PASS 3 (was 4): TOC format (mokuro alone with chapter subdirectories)
  for (const mokuro of getUnpairedMokuro()) {
    const tocResult = checkTocFormat(mokuro, imageFiles, dirStructure, pairedImageDirs);
    if (tocResult) {
      const mokuroDir = mokuro.parentDir || '.';
      const prefix = mokuroDir === '.' ? '' : mokuroDir + '/';
      for (const chapterName of tocResult.chapters.keys()) {
        pairedImageDirs.add(prefix + chapterName);
      }
      pairedMokuroPaths.add(mokuro.path);
      pairings.push(createTocPairing(mokuroDir, mokuro.path, tocResult.chapters));
    }
  }

  // PASS 4: Report orphaned mokuro files
  for (const mokuro of getUnpairedMokuro()) {
    warnings.push(`Orphaned mokuro file: ${mokuro.path} (no matching images)`);
  }

  // PASS 5 (was 7): Image-only directories (no mokuro found anywhere)
  const unpairedDirs = findUnpairedImageDirectories(pairedImageDirs, dirStructure);
  for (const dir of unpairedDirs) {
    const files = dirStructure.get(dir);
    if (files && files.size > 0) {
      pairings.push(createDirectoryPairing(dir, files, null, true));
      pairedImageDirs.add(dir);
    }
  }

  return { pairings, warnings };
}

function buildDirectoryStructure(imageFiles: CategorizedFile[]): Map<string, Map<string, string>> {
  const structure = new Map<string, Map<string, string>>();

  for (const img of imageFiles) {
    const dir = img.parentDir || '.';
    if (!structure.has(dir)) {
      structure.set(dir, new Map());
    }
    structure.get(dir)!.set(img.filename, img.path);
  }

  return structure;
}

function checkTocFormat(
  mokuro: CategorizedFile,
  imageFiles: CategorizedFile[],
  dirStructure: Map<string, Map<string, string>>,
  pairedImageDirs: Set<string>
): { chapters: Map<string, Map<string, string>> } | null {
  const mokuroDir = mokuro.parentDir || '.';

  const siblingImages = imageFiles.filter((img) => (img.parentDir || '.') === mokuroDir);
  if (siblingImages.length > 0) {
    return null;
  }

  const chapters = new Map<string, Map<string, string>>();
  const prefix = mokuroDir === '.' ? '' : mokuroDir + '/';

  for (const [dir, files] of dirStructure) {
    if (pairedImageDirs.has(dir)) continue;

    if (dir !== mokuroDir && dir.startsWith(prefix)) {
      const relativePath = prefix ? dir.slice(prefix.length) : dir;
      if (!relativePath.includes('/')) {
        chapters.set(relativePath, files);
      }
    }
  }

  if (chapters.size >= 2) {
    return { chapters };
  }

  return null;
}

function findUnpairedImageDirectories(
  pairedImageDirs: Set<string>,
  dirStructure: Map<string, Map<string, string>>
): string[] {
  const unpaired: string[] = [];
  for (const dir of dirStructure.keys()) {
    if (!pairedImageDirs.has(dir)) {
      unpaired.push(dir);
    }
  }
  return unpaired;
}

function createDirectoryPairing(
  basePath: string,
  files: Map<string, string>,
  mokuroPath: string | null,
  imageOnly: boolean
): PairedSource {
  return {
    mokuroPath,
    source: { type: 'directory', files },
    basePath,
    imageOnly
  };
}

function createTocPairing(
  basePath: string,
  mokuroPath: string,
  chapters: Map<string, Map<string, string>>
): PairedSource {
  return {
    mokuroPath,
    source: { type: 'toc-directory', chapters },
    basePath,
    imageOnly: false
  };
}
