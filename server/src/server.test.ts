import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createLibraryServer } from './server.js';

async function makeLibrary(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'mokuro-library-server-test-'));
}

async function writeFileDeep(root: string, relPath: string, content: string | Uint8Array) {
  const abs = path.join(root, relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

function mokuroJson(): string {
  return JSON.stringify({
    version: '0.2.0',
    title: 'Houseki no Kuni',
    title_uuid: 'houseki-title-uuid',
    volume: 'Volume 02',
    volume_uuid: 'houseki-volume-02-uuid',
    pages: [
      { img_path: '0001.webp', img_width: 100, img_height: 100, blocks: [] },
      { img_path: '0002.webp', img_width: 100, img_height: 100, blocks: [] }
    ],
    chars: 0
  });
}

async function startServer(root: string): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const { app, rescan } = createLibraryServer({ libraryRoot: root });
  await rescan();
  return new Promise((resolve) => {
    const server: Server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(() => res()))
      });
    });
  });
}

describe('library server HTTP API', () => {
  let root: string;
  let baseUrl: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    root = await makeLibrary();
    await writeFileDeep(root, 'Houseki no Kuni/Volume 02/0001.webp', Buffer.from([1, 2, 3]));
    await writeFileDeep(root, 'Houseki no Kuni/Volume 02/0002.webp', Buffer.from([4, 5, 6, 7]));
    await writeFileDeep(root, 'Houseki no Kuni/Volume 02.mokuro', mokuroJson());
    // A file living outside the library that a path-traversal attempt might try to reach.
    await writeFileDeep(path.dirname(root), 'secret.txt', 'do not serve me');

    const started = await startServer(root);
    baseUrl = started.baseUrl;
    close = started.close;
  });

  afterAll(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  it('lists the scanned volume', async () => {
    const res = await fetch(`${baseUrl}/api/volumes`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      volume_uuid: 'houseki-volume-02-uuid',
      series_title: 'Houseki no Kuni',
      volume_title: 'Volume 02',
      page_count: 2,
      cover_path: '0001.webp'
    });
  });

  it('serves the mokuro page data for a known volume', async () => {
    const res = await fetch(`${baseUrl}/api/volumes/houseki-volume-02-uuid`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pages).toHaveLength(2);
    expect(body.pages[0].img_path).toBe('0001.webp');
  });

  it('404s for an unknown volume uuid', async () => {
    const res = await fetch(`${baseUrl}/api/volumes/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it('serves a known page image with the correct bytes and content type', async () => {
    const res = await fetch(`${baseUrl}/api/volumes/houseki-volume-02-uuid/pages/0001.webp`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    const buf = Buffer.from(await res.arrayBuffer());
    expect([...buf]).toEqual([1, 2, 3]);
  });

  it('404s for a page filename that was never discovered by the scanner', async () => {
    const res = await fetch(`${baseUrl}/api/volumes/houseki-volume-02-uuid/pages/0099.webp`);
    expect(res.status).toBe(404);
  });

  it('cannot be used to read files outside the library via a traversal attempt', async () => {
    // Even though "../secret.txt" resolves to a real file one level above
    // the library root, it was never recorded in the volume's imageFiles
    // index, so the lookup must fail regardless of what's on disk.
    const res = await fetch(
      `${baseUrl}/api/volumes/houseki-volume-02-uuid/pages/${encodeURIComponent('../../secret.txt')}`
    );
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain('do not serve me');
  });

  it('rejects a forged volume uuid used to try to reach an arbitrary path', async () => {
    const res = await fetch(
      `${baseUrl}/api/volumes/${encodeURIComponent('../../../etc/passwd')}/pages/0001.webp`
    );
    expect(res.status).toBe(404);
  });
});
