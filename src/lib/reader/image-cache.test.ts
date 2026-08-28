import { describe, it, expect, beforeAll, vi } from 'vitest';
import { matchFilesToPages, ImageCache } from './image-cache';
import type { Page } from '$lib/types';

beforeAll(() => {
  // jsdom doesn't implement these; ImageCache only uses them to kick off a
  // background decode it doesn't need to await for the assertions below.
  if (!URL.createObjectURL) URL.createObjectURL = () => 'blob:mock';
  if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {};
});

function makePage(imgPath: string): Page {
  return { version: '1', img_width: 100, img_height: 100, blocks: [], img_path: imgPath };
}

function makeFile(name: string): File {
  return new File([name], name);
}

describe('matchFilesToPages', () => {
  it('matches every page exactly when all files are present with exact keys', () => {
    const pages = [makePage('0001.webp'), makePage('0002.webp'), makePage('0003.webp')];
    const files = {
      '0001.webp': makeFile('a'),
      '0002.webp': makeFile('b'),
      '0003.webp': makeFile('c')
    };

    const result = matchFilesToPages(files, pages);

    expect(result).toEqual([files['0001.webp'], files['0002.webp'], files['0003.webp']]);
  });

  it('keeps exact matches for arrived pages and leaves the rest undefined during progressive loading', () => {
    // Reproduces a server-library volume mid-fetch: only pages 0 and 2 have
    // arrived so far (out of page order, as concurrent HTTP fetches do),
    // page 1 hasn't landed yet.
    const pages = [makePage('0001.webp'), makePage('0002.webp'), makePage('0003.webp')];
    const files = {
      '0001.webp': makeFile('a'),
      '0003.webp': makeFile('c')
      // '0002.webp' not yet arrived
    };

    const result = matchFilesToPages(files, pages);

    expect(result[0]).toBe(files['0001.webp']);
    expect(result[1]).toBeUndefined();
    expect(result[2]).toBe(files['0003.webp']);
  });

  it('does not fall through to the positional fallback when a partial exact match exists', () => {
    // The historical bug: a single miss used to discard ALL exact matches
    // found so far and cascade all the way to Strategy 5, which naturally
    // sorts whatever files exist and assigns them positionally — silently
    // pairing the wrong image with the wrong page.
    const pages = [makePage('b.webp'), makePage('a.webp'), makePage('c.webp')];
    const files = {
      'b.webp': makeFile('B'),
      'a.webp': makeFile('A')
      // 'c.webp' missing
    };

    const result = matchFilesToPages(files, pages);

    // Strategy 5 would naturally-sort ['a.webp','b.webp'] -> assign
    // a.webp to index 0 (page 'b.webp') and b.webp to index 1 (page
    // 'a.webp') — exactly backwards. Confirm that does NOT happen.
    expect(result[0]).toBe(files['b.webp']);
    expect(result[1]).toBe(files['a.webp']);
    expect(result[2]).toBeUndefined();
  });

  it('returns an array of undefined when no files have arrived yet, without matching anything spuriously', () => {
    const pages = [makePage('0001.webp'), makePage('0002.webp')];

    const result = matchFilesToPages({}, pages);

    expect(result).toEqual([undefined, undefined]);
  });

  it('falls back to basename matching when paths differ but no exact matches exist at all', () => {
    const pages = [makePage('manga/0001.jpg'), makePage('manga/0002.jpg')];
    const files = {
      '0001.jpg': makeFile('a'),
      '0002.jpg': makeFile('b')
    };

    const result = matchFilesToPages(files, pages);

    expect(result).toEqual([files['0001.jpg'], files['0002.jpg']]);
  });

  it('falls back to basename-without-extension matching for format conversions (png -> webp)', () => {
    const pages = [makePage('0001.png'), makePage('0002.png')];
    const files = {
      '0001.webp': makeFile('a'),
      '0002.webp': makeFile('b')
    };

    const result = matchFilesToPages(files, pages);

    expect(result).toEqual([files['0001.webp'], files['0002.webp']]);
  });

  it('falls back to positional page-order matching as a last resort when nothing else matches', () => {
    const pages = [makePage('page1'), makePage('page2')];
    const files = {
      totallyUnrelatedName2: makeFile('b'),
      totallyUnrelatedName1: makeFile('a')
    };

    const result = matchFilesToPages(files, pages);

    // Natural-sorted: totallyUnrelatedName1, totallyUnrelatedName2
    expect(result).toEqual([files.totallyUnrelatedName1, files.totallyUnrelatedName2]);
  });
});

describe('ImageCache.updateCache', () => {
  it('does not throw and leaves the current page unresolved when its file has not arrived yet', () => {
    const cache = new ImageCache();
    const pages = [makePage('0001.webp'), makePage('0002.webp')];

    expect(() => cache.updateCache({}, pages, 0)).not.toThrow();
    expect(cache.getFile(0)).toBeUndefined();
    expect(cache.getImageSync(0)).toBeNull();

    cache.cleanup();
  });

  it('picks up a page whose file arrives after an earlier updateCache call', () => {
    const cache = new ImageCache();
    const pages = [makePage('0001.webp'), makePage('0002.webp')];

    cache.updateCache({}, pages, 0);
    expect(cache.getFile(0)).toBeUndefined();

    cache.updateCache({ '0001.webp': makeFile('a') }, pages, 0);
    expect(cache.getFile(0)).toBeDefined();

    cache.cleanup();
  });

  it('does not rebuild the cache when re-called with an unchanged, still-incomplete files map', () => {
    // Regression test: while a volume streams in, this.files.length is
    // ALWAYS pages.length (matchFilesToPages pads with holes), so comparing
    // against it made every call look "changed" for as long as any page
    // was still missing — including calls with no new files at all (e.g. a
    // plain page turn, or an unrelated store re-emission). That churned the
    // whole windowed cache (evict + re-create blob URLs) on every such call.
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');
    const pages = Array.from({ length: 10 }, (_, i) => makePage(`${i}.webp`));
    // Only half the pages have arrived — an incomplete/progressive map.
    const files = Object.fromEntries(
      pages.slice(0, 5).map((p) => [p.img_path, makeFile(p.img_path)])
    );

    const cache = new ImageCache();
    cache.updateCache(files, pages, 2); // window covers indices 0-5
    const callsAfterFirst = createObjectURL.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Re-call with the exact same (still incomplete) files/pages/index —
    // simulates an effect re-run with nothing new to show.
    cache.updateCache(files, pages, 2);
    expect(createObjectURL.mock.calls.length).toBe(callsAfterFirst);

    cache.cleanup();
    createObjectURL.mockRestore();
  });

  it('does rebuild once a genuinely new file arrives into an incomplete map', () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');
    const pages = Array.from({ length: 10 }, (_, i) => makePage(`${i}.webp`));
    const files: Record<string, File> = Object.fromEntries(
      pages.slice(0, 5).map((p) => [p.img_path, makeFile(p.img_path)])
    );

    const cache = new ImageCache();
    cache.updateCache(files, pages, 2);
    const callsAfterFirst = createObjectURL.mock.calls.length;

    files['5.webp'] = makeFile('5.webp');
    cache.updateCache(files, pages, 2);
    expect(createObjectURL.mock.calls.length).toBeGreaterThan(callsAfterFirst);

    cache.cleanup();
    createObjectURL.mockRestore();
  });
});
