import {
  Cesium3DTileset,
  Google2DImageryProvider,
  ImageryProvider,
  Ion,
  IonImageryProvider,
  IonResource,
  UrlTemplateImageryProvider,
  ArcGisMapServerImageryProvider,
  Credit,
} from 'cesium';
import type { GoogleMapType } from '@shared/ipc';
import type { LabelSource } from '@shared/labels';

export interface BasemapDef {
  id: string;
  label: string;
  /** Requires a Google Maps API key. */
  needsGoogleKey?: boolean;
  /** Requires a Cesium ion access token (EARTHY_ION_TOKEN). */
  needsIonKey?: boolean;
  build(opts: { customUrl?: string; googleMapType?: GoogleMapType }): Promise<ImageryProvider>;
  /**
   * A photorealistic-mesh mode: streams a 3D tileset over the globe on top of
   * whatever `build` returns (the imagery shows where meshes don't exist and
   * at far zooms). Selecting any basemap without this tears the tileset down.
   */
  buildTileset?(): Promise<Cesium3DTileset>;
}

async function ionToken(): Promise<string> {
  const token = await window.api.getIonToken();
  if (!token) throw new Error('Cesium ion token not configured');
  return token;
}

async function google(mapType: GoogleMapType): Promise<ImageryProvider> {
  const session = await window.api.getGoogleSession(mapType);
  if (!session) throw new Error('Google Maps API key not configured');
  const template = await window.api.getGoogleTileTemplate(session.session);
  return new UrlTemplateImageryProvider({
    url: template,
    maximumLevel: 22,
    credit: new Credit('Map data ©2025 Google', true),
  });
}

export const BASEMAPS: BasemapDef[] = [
  {
    // First in the list = the fresh-install default. Without a token,
    // applyBasemap falls back to Esri quietly (a missing key is an expected
    // state, not a failure). Keeps the id 'ion-aerial' so stored settings
    // survive the switch away from Bing.
    id: 'ion-aerial',
    label: 'Ion Satellite (Google)',
    needsIonKey: true,
    // Asset 3830182 = Google Maps 2D Satellite, ion's replacement for Bing
    // Aerial (asset 2), which authenticates but serves nothing since Microsoft
    // retired Bing Maps for Enterprise in mid-2025 — the account still lists
    // it, and it renders a blank layer.
    build: async () =>
      IonImageryProvider.fromAssetId(3830182, { accessToken: await ionToken() }),
  },
  {
    id: 'ion-night',
    label: 'Earth at Night (ion key)',
    needsIonKey: true,
    // Asset 3812 = NASA Black Marble, ion-hosted (streams on any account).
    build: async () =>
      IonImageryProvider.fromAssetId(3812, { accessToken: await ionToken() }),
  },
  {
    id: 'ion-sentinel2',
    label: 'Sentinel-2 (ion key)',
    needsIonKey: true,
    build: async () =>
      // Asset 3954 = ESA Sentinel-2 cloudless, ion-hosted.
      IonImageryProvider.fromAssetId(3954, { accessToken: await ionToken() }),
  },
  {
    id: 'ion-photorealistic',
    label: 'Google Photorealistic 3D (ion key)',
    needsIonKey: true,
    // Meshes bake their own imagery; Esri underneath covers mesh gaps and the
    // zoomed-out globe.
    build: () =>
      ArcGisMapServerImageryProvider.fromUrl(
        'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
        { credit: new Credit('Imagery © Esri', true) },
      ),
    buildTileset: async () => {
      const resource = await IonResource.fromAssetId(2275207, {
        accessToken: await ionToken(),
      });
      return Cesium3DTileset.fromUrl(resource);
    },
  },
  {
    id: 'esri',
    label: 'Esri World Imagery',
    build: () =>
      ArcGisMapServerImageryProvider.fromUrl(
        'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
        { credit: new Credit('Imagery © Esri', true) },
      ),
  },
  {
    id: 'osm',
    label: 'OpenStreetMap',
    build: async () =>
      new UrlTemplateImageryProvider({
        url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        maximumLevel: 19,
        credit: new Credit('© OpenStreetMap contributors', true),
      }),
  },
  {
    id: 'google-satellite',
    label: 'Google Hybrid',
    needsGoogleKey: true,
    build: () => google('satellite'),
  },
  {
    id: 'google-roadmap',
    label: 'Google Roadmap',
    needsGoogleKey: true,
    build: () => google('roadmap'),
  },
  {
    id: 'google-terrain',
    label: 'Google Terrain',
    needsGoogleKey: true,
    build: () => google('terrain'),
  },
  {
    id: 'custom',
    label: 'Custom XYZ…',
    build: async ({ customUrl }) => {
      if (!customUrl) throw new Error('No custom XYZ URL set (Settings)');
      return new UrlTemplateImageryProvider({
        url: customUrl,
        maximumLevel: 22,
        credit: new Credit('Custom tiles', true),
      });
    },
  },
];

export function basemapById(id: string): BasemapDef {
  return BASEMAPS.find((b) => b.id === id) ?? BASEMAPS[0];
}

/** Transparent place-name overlay for a label source (see shared/labels.ts). */
export async function buildLabels(source: LabelSource): Promise<ImageryProvider> {
  if (source === 'ion') {
    // The ion Google Maps 2D satellite asset the default basemap streams,
    // asked for its roadmap layer as a transparent overlay (Google's
    // `overlay: true` session) — the labels and roads of Google Hybrid without
    // the imagery under them.
    //
    // fromIonAssetId takes no token argument; it reads Ion.defaultAccessToken
    // when it builds the endpoint request, synchronously, before its first
    // await. Set it for that call only, so the token stays scoped as it is
    // everywhere else (see terrain.ts). (IonImageryProvider.fromAssetId does
    // take a token, but caches endpoints by asset + token alone, so it would
    // return the basemap's opaque satellite session for the same asset.)
    const token = await ionToken();
    const previous = Ion.defaultAccessToken;
    Ion.defaultAccessToken = token;
    let pending: Promise<Google2DImageryProvider>;
    try {
      pending = Google2DImageryProvider.fromIonAssetId({
        assetId: '3830182',
        overlayLayerType: 'layerRoadmap',
      });
    } finally {
      Ion.defaultAccessToken = previous;
    }
    // The cast papers over Cesium's typings: Google2DImageryProvider's
    // getTileCredits is declared `Credit[] | undefined`, ImageryProvider's
    // `Credit[]`. It is an ImageryProvider at runtime.
    return (await pending) as unknown as ImageryProvider;
  }
  return ArcGisMapServerImageryProvider.fromUrl(
    'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer',
    { credit: new Credit('Labels © Esri', true) },
  );
}
