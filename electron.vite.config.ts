import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const CESIUM_SOURCE = 'node_modules/cesium/Build/Cesium';
// Cesium loads these at runtime relative to window.CESIUM_BASE_URL ('./cesium').
const CESIUM_ASSET_DIRS = ['Assets', 'ThirdParty', 'Widgets', 'Workers'];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Separate entry: runs GDAL/WASM in a worker_thread so long imports
          // never block the main process.
          'gdal-worker': resolve(__dirname, 'src/main/gdal-worker.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    plugins: [
      react(),
      viteStaticCopy({
        targets: CESIUM_ASSET_DIRS.map((dir) => ({
          // Absolute path: static-copy resolves `src` against the renderer root
          // (src/renderer), so we must anchor to the project root ourselves.
          src: resolve(__dirname, CESIUM_SOURCE, dir),
          dest: 'cesium',
        })),
      }),
    ],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
