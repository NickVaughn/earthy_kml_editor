/**
 * Place-name search, run in main so the request carries a proper User-Agent
 * (Nominatim's policy) and the ion token never reaches the renderer.
 */
import { app, net } from 'electron';
import { apiKey } from './keys';
import {
  parseNominatim,
  parsePelias,
  type GeocodeResponse,
  type GeocodeResult,
  type GeocodeSource,
} from '../shared/geocode';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const ION_URL = 'https://api.cesium.com/v1/geocode/search';
const LIMIT = 6;

/** Cesium ion access token, or null. EARTHY_ION_TOKEN preferred; the
 *  ecosystem-conventional CESIUM_ION_TOKEN is honoured too. */
export function getIonToken(): string | null {
  return apiKey('EARTHY_ION_TOKEN', 'CESIUM_ION_TOKEN');
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await net.fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function searchNominatim(query: string): Promise<GeocodeResult[]> {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', String(LIMIT));
  return parseNominatim(
    await fetchJson(url.toString(), {
      // Nominatim's usage policy: identify the application.
      'User-Agent': `Earthy/${app.getVersion()} (https://github.com/NickVaughn/earthy_kml_editor)`,
      Accept: 'application/json',
    }),
  );
}

async function searchIon(query: string, token: string): Promise<GeocodeResult[]> {
  const url = new URL(ION_URL);
  url.searchParams.set('text', query);
  url.searchParams.set('access_token', token);
  return parsePelias(await fetchJson(url.toString(), { Accept: 'application/json' }));
}

/**
 * Search `source` for `query`. OpenStreetMap falls back to ion when it comes
 * back empty or fails and a token is configured — the sources index different
 * data, so a miss on one is often a hit on the other.
 */
export async function geocode(query: string, source: GeocodeSource): Promise<GeocodeResponse> {
  const q = query.trim();
  if (!q) return { results: [], source };
  const token = getIonToken();
  if (source === 'ion') {
    if (!token) return { results: [], source, error: 'Cesium ion token not configured' };
    try {
      return { results: await searchIon(q, token), source };
    } catch (err) {
      return { results: [], source, error: `Cesium ion search failed: ${message(err)}` };
    }
  }
  let osmError: string | null = null;
  try {
    const results = await searchNominatim(q);
    if (results.length) return { results, source: 'osm' };
  } catch (err) {
    osmError = message(err);
  }
  if (token) {
    try {
      return { results: await searchIon(q, token), source: 'ion' };
    } catch (err) {
      if (!osmError) osmError = message(err);
    }
  }
  return osmError
    ? { results: [], source: 'osm', error: `Search failed: ${osmError}` }
    : { results: [], source: 'osm' };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
