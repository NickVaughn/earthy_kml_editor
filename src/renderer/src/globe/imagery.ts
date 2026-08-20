import {
  ImageryProvider,
  IonImageryProvider,
  UrlTemplateImageryProvider,
  ArcGisMapServerImageryProvider,
  Credit,
} from 'cesium';
import type { GoogleMapType } from '@shared/ipc';

export interface BasemapDef {
  id: string;
  label: string;
  /** Requires a Google Maps API key. */
  needsGoogleKey?: boolean;
  /** Requires a Cesium ion access token (EARTHY_ION_TOKEN). */
  needsIonKey?: boolean;
  build(opts: { customUrl?: string; googleMapType?: GoogleMapType }): Promise<ImageryProvider>;
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
    build: async () => {
      const token = await window.api.getIonToken();
      if (!token) throw new Error('Cesium ion token not configured');
      // Asset 3830182 = Google Maps 2D Satellite, ion's replacement for Bing
      // Aerial (asset 2), which authenticates but serves nothing since
      // Microsoft retired Bing Maps for Enterprise in mid-2025 — the account
      // still lists it, and it renders a blank layer.
      return IonImageryProvider.fromAssetId(3830182, { accessToken: token });
    },
  },
  {
    id: 'ion-night',
    label: 'Earth at Night (ion key)',
    needsIonKey: true,
    build: async () => {
      const token = await window.api.getIonToken();
      if (!token) throw new Error('Cesium ion token not configured');
      // Asset 3812 = NASA Black Marble, ion-hosted (streams on any account).
      return IonImageryProvider.fromAssetId(3812, { accessToken: token });
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
