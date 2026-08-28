import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanLibrary } from './scan.js';

const tempDirs: string[] = [];

async function makeLibrary(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mokuro-library-test-'));
  tempDirs.push(dir);
  return dir;
}

async function writeFileDeep(root: string, relPath: string, content: string | Uint8Array) {
  const abs = path.join(root, relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

function mokuroJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: '0.2.0',
    title: 'Houseki no Kuni',
    title_uuid: 'houseki-title-uuid',
    volume: 'Volume 02',
    volume_uuid: 'houseki-volume-02-uuid',
    pages: [
      { img_path: '0001.webp', img_width: 100, img_height: 100, blocks: [] },
      { img_path: '0002.webp', img_width: 100, img_height: 100, blocks: [{ lines: ['テスト'] }] }
    ],
    chars: 3,
    ...overrides
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('scanLibrary', () => {
  it('finds a volume whose mokuro is nested under a wrapper folder, alongside an _ocr cache dir', async () => {
    // Reproduces the exact real-world layout that broke the browser-side
    // archive import: zipping a mokuro output folder wraps everything in
    // one top-level directory.
    const root = await makeLibrary();
    await writeFileDeep(root, 'Houseki no Kuni/_ocr/Volume 02/0001.json', '{}');
    await writeFileDeep(root, 'Houseki no Kuni/Volume 02/0001.webp', Buffer.from([1, 2, 3]));
    await writeFileDeep(root, 'Houseki no Kuni/Volume 02/0002.webp', Buffer.from([4, 5, 6]));
    await writeFileDeep(root, 'Houseki no Kuni/Volume 02.html', '<html></html>');
    await writeFileDeep(root, 'Houseki no Kuni/Volume 02.mokuro', mokuroJson());

    const index = await scanLibrary(root);

    expect(index.volumes.size).toBe(1);
    const volume = index.volumes.get('houseki-volume-02-uuid');
    expect(volume).toBeDefined();
    expect(volume!.seriesTitle).toBe('Houseki no Kuni');
    expect(volume!.volumeTitle).toBe('Volume 02');
    expect(volume!.missingPages).toBe(0);
    expect(volume!.imageFiles.size).toBe(2);
    expect(volume!.imageFiles.get('0001.webp')).toBe(
      path.join(root, 'Houseki no Kuni/Volume 02/0001.webp')
    );
    expect(volume!.coverImgPath).toBe('0001.webp');
  });

  it('finds a volume with mokuro directly inside the image folder', async () => {
    const root = await makeLibrary();
    await writeFileDeep(root, 'manga/manga.mokuro', mokuroJson({ volume_uuid: 'same-dir-uuid' }));
    await writeFileDeep(root, 'manga/0001.webp', Buffer.from([1]));
    await writeFileDeep(root, 'manga/0002.webp', Buffer.from([2]));

    const index = await scanLibrary(root);

    expect(index.volumes.size).toBe(1);
    expect(index.volumes.get('same-dir-uuid')?.missingPages).toBe(0);
  });

  it('treats an image folder with no mokuro anywhere as an image-only volume', async () => {
    const root = await makeLibrary();
    await writeFileDeep(root, 'Some Series/Volume 01/001.jpg', Buffer.from([1]));
    await writeFileDeep(root, 'Some Series/Volume 01/002.jpg', Buffer.from([2]));

    const index = await scanLibrary(root);

    expect(index.volumes.size).toBe(1);
    const [volume] = Array.from(index.volumes.values());
    expect(volume.mokuroVersion).toBe('');
    expect(volume.pageCount).toBe(2);
    expect(volume.imageFiles.get('001.jpg')).toBe(
      path.join(root, 'Some Series/Volume 01/001.jpg')
    );
  });

  it('reports missing pages instead of silently dropping them when files are absent', async () => {
    const root = await makeLibrary();
    await writeFileDeep(
      root,
      'manga/manga.mokuro',
      mokuroJson({ volume_uuid: 'missing-pages-uuid' })
    );
    await writeFileDeep(root, 'manga/0001.webp', Buffer.from([1]));
    // 0002.webp intentionally not written

    const index = await scanLibrary(root);
    const volume = index.volumes.get('missing-pages-uuid');
    expect(volume?.missingPages).toBe(1);
    expect(volume?.missingPagePaths).toEqual(['0002.webp']);
  });

  it('ignores an orphaned mokuro file with no matching images and records a warning', async () => {
    const root = await makeLibrary();
    await writeFileDeep(root, 'lonely.mokuro', mokuroJson({ volume_uuid: 'lonely-uuid' }));

    const index = await scanLibrary(root);

    expect(index.volumes.size).toBe(0);
    expect(index.warnings.some((w) => w.includes('lonely.mokuro'))).toBe(true);
  });

  it('recovers from one bad mokuro file without losing the rest of the library', async () => {
    const root = await makeLibrary();
    await writeFileDeep(root, 'broken/broken.mokuro', '{ this is not valid json');
    await writeFileDeep(root, 'broken/0001.webp', Buffer.from([1]));
    await writeFileDeep(root, 'good/good.mokuro', mokuroJson({ volume_uuid: 'good-uuid' }));
    await writeFileDeep(root, 'good/0001.webp', Buffer.from([1]));
    await writeFileDeep(root, 'good/0002.webp', Buffer.from([2]));

    const index = await scanLibrary(root);

    expect(index.volumes.has('good-uuid')).toBe(true);
    expect(index.warnings.some((w) => w.includes('broken.mokuro'))).toBe(true);
  });
});
