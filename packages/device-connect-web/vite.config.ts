import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  publicDir: '../../node_modules/@voicecan/device-core/private/browser',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'connect.js',
        assetFileNames: 'connect.css',
        inlineDynamicImports: true,
      },
    },
  },
  server: { port: 5175, strictPort: true },
});
