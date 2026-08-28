import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  // Consult https://kit.svelte.dev/docs/integrations#preprocessors
  // for more information about preprocessors
  preprocess: vitePreprocess(),

  kit: {
    // The whole app is client-only (ssr = false, hash-based routing over
    // IndexedDB), so it builds to a static SPA that any static file server
    // (nginx in the bundled Dockerfile, GitHub Pages, etc.) can serve.
    adapter: adapter({
      fallback: 'index.html'
    })
  },

  vitePlugin: {
    inspector: true
  }
};

export default config;
