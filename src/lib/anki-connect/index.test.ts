import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writable, type Writable } from 'svelte/store';

vi.mock('$lib/settings', async () => {
  const { writable } = await import('svelte/store');
  return {
    settings: writable({
      ankiConnectSettings: { url: 'http://walvie-pc.tail854d49.ts.net:8765' }
    }),
    DEFAULT_MODEL_CONFIGS: {}
  };
});

vi.mock('$lib/util', () => ({
  showSnackbar: vi.fn()
}));

vi.mock('$lib/util/platform', () => ({
  isMobilePlatform: vi.fn().mockReturnValue(false)
}));

import { testConnection, ankiConnect } from './index';
import { settings } from '$lib/settings';
import { showSnackbar } from '$lib/util';

const settingsStore = settings as unknown as Writable<{
  ankiConnectSettings: { url: string };
}>;

function jsonResponse(body: unknown): Response {
  return { json: () => Promise.resolve(body) } as unknown as Response;
}

describe('anki-connect network-failure detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsStore.set({
      ankiConnectSettings: { url: 'http://walvie-pc.tail854d49.ts.net:8765' }
    });
    vi.stubGlobal('fetch', vi.fn());
  });

  // A blocked/failed cross-origin fetch() always rejects with a generic
  // TypeError — only the message text differs by browser. Chrome: "Failed
  // to fetch". Firefox (the case that was previously mishandled, since the
  // old code only matched the Chrome wording): "NetworkError when
  // attempting to fetch resource.". Safari: "Load failed".
  const browserErrorMessages = [
    ['Chrome', 'Failed to fetch'],
    ['Firefox', 'NetworkError when attempting to fetch resource.'],
    ['Safari', 'Load failed']
  ] as const;

  describe('testConnection', () => {
    it.each(browserErrorMessages)(
      '%s-style TypeError: retries via requestPermission and reports combined guidance when not granted',
      async (_browser, message) => {
        const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
        // First call ('version') rejects; second call (requestPermission) resolves not-granted.
        mockFetch
          .mockRejectedValueOnce(new TypeError(message))
          .mockResolvedValueOnce(jsonResponse({ result: { permission: 'denied' } }));

        const result = await testConnection();

        expect(result.success).toBe(false);
        expect(result.error).toBe('network');
        expect(result.message).toContain('webCorsOriginList');
        expect(result.message).toContain('webBindAddress');
        expect(mockFetch).toHaveBeenCalledTimes(2);
      }
    );

    it('retries and succeeds once Anki grants permission after a blocked request', async () => {
      const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
      mockFetch
        .mockRejectedValueOnce(new TypeError('NetworkError when attempting to fetch resource.'))
        .mockResolvedValueOnce(jsonResponse({ result: { permission: 'granted' } }))
        .mockResolvedValueOnce(jsonResponse({ result: 6 }));

      const result = await testConnection();

      expect(result.success).toBe(true);
      expect(result.version).toBe(6);
    });

    it('succeeds on a normal connection without touching requestPermission', async () => {
      const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValue(jsonResponse({ result: 6 }));

      const result = await testConnection();

      expect(result).toEqual({
        success: true,
        message: 'Connected to AnkiConnect v6',
        version: 6
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('reports an anki_error for a non-network failure without retrying', async () => {
      const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValue(jsonResponse({ error: 'unsupported version' }));

      const result = await testConnection();

      expect(result).toEqual({
        success: false,
        error: 'anki_error',
        message: 'Anki error: unsupported version'
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does not misclassify a non-TypeError failure (e.g. JSON parse error) as a network issue', async () => {
      const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValue({
        json: () => Promise.reject(new SyntaxError('Unexpected token'))
      } as unknown as Response);

      const result = await testConnection();

      expect(result.error).toBe('invalid_response');
      expect(mockFetch).toHaveBeenCalledTimes(1); // no permission-request retry
    });
  });

  describe('ankiConnect', () => {
    it.each(browserErrorMessages)(
      '%s-style TypeError on a real action: retries once, then shows actionable guidance',
      async (_browser, message) => {
        const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
        mockFetch
          .mockRejectedValueOnce(new TypeError(message))
          .mockResolvedValueOnce(jsonResponse({ result: { permission: 'denied' } }));

        const result = await ankiConnect('deckNames', {});

        expect(result).toBeUndefined();
        expect(showSnackbar).toHaveBeenCalledWith(expect.stringContaining('webCorsOriginList'));
      }
    );

    it('stays silent (no snackbar) in silent mode even on a network failure', async () => {
      const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
      mockFetch.mockRejectedValue(new TypeError('NetworkError when attempting to fetch resource.'));

      const result = await ankiConnect('deckNames', {}, { silent: true });

      expect(result).toBeUndefined();
      expect(showSnackbar).not.toHaveBeenCalled();
    });
  });
});
