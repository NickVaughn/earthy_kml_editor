import type { GoogleSession, GoogleMapType } from '@shared/ipc';
import { apiKey } from './keys';

/**
 * Google Map Tiles API session management.
 * Docs: https://developers.google.com/maps/documentation/tile/session_tokens
 *
 * A session token is required before requesting 2D tiles, and is valid for up
 * to ~2 weeks. We cache one session per map type and renew on expiry.
 */

interface CachedSession {
  session: GoogleSession;
  mapType: GoogleMapType;
}

const cache = new Map<GoogleMapType, CachedSession>();

export function getGoogleKey(): string | null {
  // EARTHY_* is the current name; NGE_* still works for pre-rename setups.
  return apiKey('EARTHY_GOOGLE_MAPS_API_KEY', 'NGE_GOOGLE_MAPS_API_KEY');
}

export function hasGoogleKey(): boolean {
  return getGoogleKey() !== null;
}

export async function getGoogleSession(
  mapType: GoogleMapType,
): Promise<GoogleSession | null> {
  const key = getGoogleKey();
  if (!key) return null;

  const cached = cache.get(mapType);
  // Renew if missing or within 5 minutes of expiry.
  if (cached && cached.session.expiry - Date.now() > 5 * 60 * 1000) {
    return cached.session;
  }

  const body: Record<string, unknown> = {
    mapType,
    language: 'en-US',
    region: 'US',
  };
  // Google *requires* the roadmap layer with terrain ("When selecting terrain as
  // the map type, you must also include the layerRoadmap layer type") — without
  // it createSession fails. For satellite we ask for it deliberately, to get
  // hybrid labels over the imagery.
  if (mapType === 'satellite' || mapType === 'terrain') {
    body.layerTypes = ['layerRoadmap'];
  }

  const res = await fetch(
    `https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Google createSession failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as {
    session: string;
    expiry: string; // seconds since epoch, as a string
    tileWidth: number;
    tileHeight: number;
    imageFormat: string;
  };

  const session: GoogleSession = {
    session: json.session,
    expiry: Number(json.expiry) * 1000,
    tileWidth: json.tileWidth ?? 256,
    tileHeight: json.tileHeight ?? 256,
    imageFormat: json.imageFormat ?? 'jpeg',
  };
  cache.set(mapType, { session, mapType });
  return session;
}

/** Build the Cesium UrlTemplate URL. Cesium substitutes {z}/{x}/{y}. */
export function googleTileTemplate(session: string): string {
  const key = getGoogleKey();
  if (!key) throw new Error('No Google Maps API key configured');
  return `https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${encodeURIComponent(
    session,
  )}&key=${encodeURIComponent(key)}`;
}
