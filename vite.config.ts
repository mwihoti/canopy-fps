import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The whole game (Three.js included) is inlined into one dist/index.html.
export default defineConfig({
  base: './',                     // relative URLs: works from any sub-path (GitHub Pages, itch.io, ...)
  plugins: [viteSingleFile()],
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
