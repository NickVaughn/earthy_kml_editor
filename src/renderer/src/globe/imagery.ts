import {
  ImageryProvider,
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
    label: 'Google Satellite',
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
