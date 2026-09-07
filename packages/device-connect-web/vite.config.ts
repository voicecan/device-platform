import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), 'VOICECAN_');
  const rawUuid = (process.env.VOICECAN_BLE_SERVICE_UUID ?? environment.VOICECAN_BLE_SERVICE_UUID)?.trim().toLowerCase() || '00001a10-0000-1000-8000-00805f9b34fb';
  const uuid = /^(?:[0-9a-f]{4}|[0-9a-f]{8})$/.test(rawUuid) ? `${rawUuid.padStart(8, '0')}-0000-1000-8000-00805f9b34fb` : rawUuid;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) throw new Error('Invalid VOICECAN_BLE_SERVICE_UUID');
  return {
    define: { __VOICECAN_BLE_SERVICE_UUID__: JSON.stringify(uuid) },
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
  };
});
