import express, { type Request, type Response, type NextFunction } from 'express';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { getImageMimeType, parseFilePath } from './types.js';
import { scanLibrary } from './scan.js';
import { emptyIndex, type LibraryIndex, type VolumeIndexEntry } from './library-index.js';

export interface LibraryServerOptions {
  libraryRoot: string;
}

function volumeSummary(entry: VolumeIndexEntry) {
  return {
    volume_uuid: entry.volumeUuid,
    series_uuid: entry.seriesUuid,
    series_title: entry.seriesTitle,
    volume_title: entry.volumeTitle,
    mokuro_version: entry.mokuroVersion,
    page_count: entry.pageCount,
    character_count: entry.characterCount,
    page_char_counts: entry.pageCharCounts,
    missing_pages: entry.missingPages || undefined,
    missing_page_paths: entry.missingPages ? entry.missingPagePaths : undefined,
    spine_width: entry.spineWidth,
    cover_path: entry.coverImgPath
  };
}

export function createLibraryServer(options: LibraryServerOptions) {
  const app = express();
  app.disable('x-powered-by');

  let index: LibraryIndex = emptyIndex();
  let scanning: Promise<void> | null = null;

  async function rescan(): Promise<void> {
    if (scanning) return scanning;
    scanning = scanLibrary(options.libraryRoot)
      .then((newIndex) => {
        index = newIndex;
      })
      .finally(() => {
        scanning = null;
      });
    return scanning;
  }

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      volumeCount: index.volumes.size,
      scannedAt: index.scannedAt,
      scanning: scanning !== null
    });
  });

  app.get('/api/volumes', (_req: Request, res: Response) => {
    res.json(Array.from(index.volumes.values()).map(volumeSummary));
  });

  app.get('/api/volumes/:uuid', (req: Request, res: Response) => {
    const entry = index.volumes.get(req.params.uuid);
    if (!entry) {
      res.status(404).json({ error: 'Volume not found' });
      return;
    }
    res.json({ volume_uuid: entry.volumeUuid, pages: entry.pages });
  });

  // Wildcard tail so nested img_path values (e.g. "ch01/0001.webp" for
  // TOC-format volumes) round-trip correctly. Express decodes %XX escapes
  // in the wildcard but preserves literal "/" separators.
  app.get('/api/volumes/:uuid/pages/*', async (req: Request, res: Response) => {
    const entry = index.volumes.get(req.params.uuid);
    if (!entry) {
      res.status(404).json({ error: 'Volume not found' });
      return;
    }

    // The only paths ever served are ones the scanner itself discovered and
    // recorded in this volume's imageFiles map — req.params[0] is used
    // purely as a lookup key, never concatenated into a filesystem path.
    const imgPath = req.params[0];
    const absPath = entry.imageFiles.get(imgPath);
    if (!absPath) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    try {
      const st = await stat(absPath);
      const { extension } = parseFilePath(absPath);
      res.setHeader('Content-Type', getImageMimeType(extension));
      res.setHeader('Content-Length', String(st.size));
      res.setHeader('Cache-Control', 'private, max-age=3600');
      createReadStream(absPath)
        .on('error', (err) => {
          console.error(`[library-server] error streaming ${absPath}:`, err);
          if (!res.headersSent) res.status(500).end();
        })
        .pipe(res);
    } catch (err) {
      console.error(`[library-server] error serving ${absPath}:`, err);
      res.status(404).json({ error: 'Page not found' });
    }
  });

  app.post('/api/rescan', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      await rescan();
      res.json({ ok: true, volumeCount: index.volumes.size, scannedAt: index.scannedAt });
    } catch (err) {
      next(err);
    }
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[library-server] unhandled error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  });

  return {
    app,
    rescan,
    getIndex: () => index
  };
}
