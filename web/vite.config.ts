import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Built straight into the server's static root. One container, one origin, so
  // there is no API base URL to configure and nothing to bake in at build time.
  build: { outDir: '../dist/public', emptyOutDir: true },
  server: {
    // Dev only: `npm run dev` in web/ proxies the API to a locally running
    // server so the client can be worked on without a container.
    //
    // `/plugins` matters as much as `/api`: installed plugins' client halves are import()ed
    // from /plugins/<id>/client.js, so without it the dev server silently renders no plugin UI
    // at all — no DJ panel, no chords button — and the plugin half of the app is untestable in
    // the one build where StrictMode surfaces impure-updater bugs.
    proxy: { '/api': 'http://127.0.0.1:8080', '/plugins': 'http://127.0.0.1:8080' },
  },
});
