import type { GoogleSession, GoogleMapType } from '@shared/ipc';

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
  const key = process.env.NGE_GOOGLE_MAPS_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
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
  // Hybrid labels over satellite: request the roadmap label layer.
  if (mapType === 'satellite') {
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
