import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const trackId = searchParams.get("trackId");
    const title = searchParams.get("title");
    const artist = searchParams.get("artist");
    const album = searchParams.get("album") || undefined;
    const year = searchParams.get("year") || undefined;

    if (!trackId || !title || !artist) {
      return NextResponse.json({ error: "Missing parameters" }, { status: 400 });
    }

    // 1. Check Cache
    const cached = await prisma.songLinkCache.findUnique({
      where: { trackId }
    });

    if (cached) {
      return NextResponse.json({
        spotifyUrl: cached.spotifyUrl,
        appleMusicUrl: cached.appleMusicUrl
      });
    }

    // 2. Resolve Links (Concurrently). Each provider walks its own
    // fallback chain: with album (+year) → without album → without year.
    // Album/year tags are often wrong but title/artist are trusted.
    const [appleMusicUrl, spotifyUrl] = await Promise.all([
      resolveAppleMusic(title, artist, album),
      resolveSpotify(title, artist, album, year)
    ]);

    // 3. Cache the results
    await prisma.songLinkCache.create({
      data: {
        trackId,
        spotifyUrl,
        appleMusicUrl
      }
    });

    return NextResponse.json({ spotifyUrl, appleMusicUrl });
  } catch (error) {
    console.error("Error resolving links:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const matches = (haystack: unknown, needle: string) =>
  typeof haystack === "string" && needle !== "" && norm(haystack).includes(norm(needle));

async function resolveAppleMusic(title: string, artist: string, album?: string): Promise<string | null> {
  // Level 1 demands an album match, level 2 track+artist, level 3 top hit.
  const terms = album
    ? [`${title} ${artist} ${album}`, `${title} ${artist}`, `${title} ${artist}`]
    : [`${title} ${artist}`, `${title} ${artist}`];
  for (let level = 0; level < terms.length; level++) {
    try {
      const term = encodeURIComponent(terms[level]);
      const res = await fetch(`https://itunes.apple.com/search?term=${term}&entity=song&limit=5`);
      if (!res.ok) continue;
      const data = await res.json();
      const results = (data.results || []) as any[];
      const hit = results.find((r) => {
        if (!matches(r.trackName, title) || !matches(r.artistName, artist)) return false;
        if (level === 0 && album) return matches(r.collectionName, album);
        return true;
      }) || (level === terms.length - 1 ? results[0] : undefined);
      if (hit?.trackViewUrl) return hit.trackViewUrl;
    } catch (e) {
      console.error("Apple Music search error:", e);
    }
  }
  return null;
}

// Global variable to hold Spotify token to prevent spamming Auth endpoint
let cachedSpotifyToken: string | null = null;
let spotifyTokenExpiry = 0;

async function getSpotifyToken(): Promise<string | null> {
  if (cachedSpotifyToken && Date.now() < spotifyTokenExpiry) {
    return cachedSpotifyToken;
  }
  
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  
  if (!clientId || !clientSecret) return null;

  try {
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    });
    
    if (!res.ok) return null;
    
    const data = await res.json();
    cachedSpotifyToken = data.access_token;
    spotifyTokenExpiry = Date.now() + (data.expires_in * 1000) - 60000; // 1 min buffer
    return cachedSpotifyToken;
  } catch (e) {
    console.error("Spotify Auth Error:", e);
    return null;
  }
}

async function resolveSpotify(title: string, artist: string, album?: string, year?: string): Promise<string | null> {
  try {
    const token = await getSpotifyToken();
    if (!token) return null;

    // Level 1: everything. Level 2: drop album. Level 3: drop year too.
    const queries = [
      [`track:"${title}"`, `artist:"${artist}"`, album ? `album:"${album}"` : "", year ? `year:${year}` : ""].filter(Boolean).join(" "),
      [`track:"${title}"`, `artist:"${artist}"`, year ? `year:${year}` : ""].filter(Boolean).join(" "),
      `track:"${title}" artist:"${artist}"`,
    ];
    for (const q of queries) {
      const res = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=1`, {
        headers: {
          "Authorization": `Bearer ${token}`
        }
      });
      if (!res.ok) continue;
      const data = await res.json();
      const item = data.tracks?.items?.[0];
      if (item?.external_urls?.spotify) return item.external_urls.spotify;
    }
  } catch (e) {
    console.error("Spotify search error:", e);
  }
  return null;
}
