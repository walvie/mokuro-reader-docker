import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render } from '@testing-library/svelte';
import MangaPage from '../MangaPage.svelte';
import type { Page } from '$lib/types';

vi.mock('$lib/settings', async () => {
  const { writable } = await import('svelte/store');
  return {
    settings: writable({
      fontSize: 'auto',
      boldFont: false,
      displayOCR: true,
      alwaysShowOCR: true,
      textBoxBorders: false,
      textEditable: false,
      ankiConnectSettings: { triggerMethod: 'doubleTap', tags: [], cardMode: 'single' }
    }),
    volumes: writable({})
  };
});

vi.mock('$lib/catalog/db', () => ({
  db: { volumes: { get: vi.fn() } }
}));

vi.mock('$lib/anki-connect', () => ({
  showCropper: vi.fn(),
  openCreateModal: vi.fn(),
  openUpdateModal: vi.fn(),
  expandTextBoxBounds: vi.fn(),
  sendQuickCapture: vi.fn(),
  getLastCardInfo: vi.fn(),
  getCardAgeInMin: vi.fn(),
  extractFieldValues: vi.fn(),
  getModelConfig: vi.fn(),
  blobToBase64: vi.fn()
}));

beforeAll(() => {
  // jsdom doesn't implement these; MangaPage uses them only when a `src`
  // File is given, to build a blob URL for the background image.
  if (!URL.createObjectURL) URL.createObjectURL = () => 'blob:mock';
  if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {};
});

function makePage(): Page {
  return { version: '1', img_width: 100, img_height: 100, blocks: [], img_path: '0001.webp' };
}

describe('MangaPage', () => {
  it('shows a loading indicator when no image is available yet and the page is not known-missing', () => {
    const { getByTestId } = render(MangaPage, {
      props: { page: makePage(), volumeUuid: 'v1' }
    });

    expect(getByTestId('page-loading')).toBeTruthy();
  });

  it('hides the loading indicator once a cachedUrl is provided', () => {
    const { queryByTestId } = render(MangaPage, {
      props: { page: makePage(), volumeUuid: 'v1', cachedUrl: 'blob:cached' }
    });

    expect(queryByTestId('page-loading')).toBeNull();
  });

  it('hides the loading indicator once a src File is provided', () => {
    const { queryByTestId } = render(MangaPage, {
      props: { page: makePage(), volumeUuid: 'v1', src: new File([], '0001.webp') }
    });

    expect(queryByTestId('page-loading')).toBeNull();
  });

  it('does not show a loading spinner for a page known to be permanently missing', () => {
    // isMissing=true means the image is never coming (e.g. a corrupt source
    // file on a server-library volume) — a spinner here would just spin
    // forever and mislead the reader into thinking it's still loading.
    const { queryByTestId } = render(MangaPage, {
      props: { page: makePage(), volumeUuid: 'v1', isMissing: true }
    });

    expect(queryByTestId('page-loading')).toBeNull();
  });
});
