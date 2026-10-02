/**
 * How long the current track will play, when the backend does not say.
 *
 * now-playing carries `duration` only when the Subwave host knows it — a tracked
 * queue play or a library record with a duration. When both are missing (an
 * untracked auto-playlist pick from an untagged file), it arrives null, and
 * everything downstream of it — the on-screen countdown, the end-of-track skip
 * lock, the lock-screen progress — silently stops. A missing countdown reads as
 * a broken player, not as an unknown length, so this resolves one from what the
 * host DOES always send.
 *
 * The fallback is the station's own history: every finished play carries
 * startedAt and endedAt, so a track that has aired before has a measured wall
 * time. That is arguably the righter number than a tagged length anyway — it is
 * how long the track actually occupied, crossfade included, which is what "how
 * much is left" means to a listener.
 *
 * Returns null only when nothing is knowable (a track that has never aired here).
 * Callers must handle null by showing elapsed time or nothing — never by
 * inventing a number.
 */
export function resolveTrackDuration(
  nowPlaying: any,
  history: any
): number | null {
  const direct = Number(nowPlaying?.duration);
  if (Number.isFinite(direct) && direct > 0) return direct;

  if (!Array.isArray(history)) return null;
  const id = nowPlaying?.subsonic_id ?? nowPlaying?.id ?? null;
  const title = typeof nowPlaying?.title === "string" ? nowPlaying.title.trim().toLowerCase() : "";
  const artist = typeof nowPlaying?.artist === "string" ? nowPlaying.artist.trim().toLowerCase() : "";
  if (!id && !title) return null;

  for (const h of history) {
    if (!h || typeof h !== "object") continue;
    const sameId = id && (h.subsonic_id === id || h.id === id);
    const sameTrack =
      sameId ||
      (title &&
        typeof h.title === "string" &&
        h.title.trim().toLowerCase() === title &&
        (!artist || (typeof h.artist === "string" && h.artist.trim().toLowerCase() === artist)));
    if (!sameTrack) continue;
    const start = Date.parse(h.startedAt);
    const end = Date.parse(h.endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const secs = Math.round((end - start) / 1000);
    // History order is newest first, so the first match is the most recent airing.
    // Sanity bounds: a "song" under ten seconds or over an hour is a corrupt row
    // (or a DJ set the history split oddly), not a duration to display.
    if (secs >= 10 && secs <= 3600) return secs;
  }
  return null;
}
