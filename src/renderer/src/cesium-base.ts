/**
 * Tell Cesium where to load its runtime assets (Workers, Assets, ThirdParty,
 * Widgets) from. These are copied to `<outDir>/cesium` by vite-plugin-static-copy.
 *
 * This module MUST be imported before any `cesium` import so the global is set
 * before Cesium's engine initializes. `./cesium` is relative, so it resolves
 * correctly both under the dev server (/cesium) and the packaged file:// build.
 */
declare global {
  interface Window {
    CESIUM_BASE_URL?: string;
  }
}

window.CESIUM_BASE_URL = './cesium';

export {};
