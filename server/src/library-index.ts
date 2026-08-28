/**
 * In-memory index of the mounted library, built by scan.ts and served by
 * server.ts.
 *
 * The index is the ONLY thing that decides which filesystem paths the HTTP
 * API will ever read: routes never build a disk path from a request
 * parameter directly (see server.ts). Every path a client can retrieve was
 * discovered by the scanner walking the library root, so a request for an
 * unknown/forged filename or volume id simply finds nothing in the index
 * (404) rather than resolving to an arbitrary path on disk.
 */

export interface MokuroPageEntry {
  version?: string;
  img_width?: number;
  img_height?: number;
  img_path: string;
  blocks: unknown[];
}

export interface VolumeIndexEntry {
  volumeUuid: string;
  seriesUuid: string;
  seriesTitle: string;
  volumeTitle: string;
  /** Path to this volume's image folder, relative to the library root (e.g. "Series/Volume 02") */
  libraryPath: string;
  /** '' for image-only volumes (no .mokuro file found) */
  mokuroVersion: string;
  pageCount: number;
  characterCount: number;
  pageCharCounts: number[];
  missingPages: number;
  missingPagePaths: string[];
  spineWidth?: number;
  /** img_path (as referenced by `pages`) the catalog should use for a cover thumbnail */
  coverImgPath: string | null;
  /** Full page data, shaped exactly like VolumeOCR.pages on the frontend */
  pages: MokuroPageEntry[];
  /** img_path -> absolute filesystem path. Never exposed directly to clients. */
  imageFiles: Map<string, string>;
}

export interface LibraryIndex {
  volumes: Map<string, VolumeIndexEntry>;
  scannedAt: string;
  warnings: string[];
}

export function emptyIndex(): LibraryIndex {
  return { volumes: new Map(), scannedAt: new Date(0).toISOString(), warnings: [] };
}
