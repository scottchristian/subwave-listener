/**
 * Should this tab send its presence heartbeat right now?
 *
 * CLIENT-ONLY (window): import from client components only. A heartbeat is a
 * database write, and an open-but-ignored tab is the commonest way a station
 * keeps its database awake all night: the player polls every 15s whether
 * anyone is there or not. So a tab earns its heartbeat by playing audio, by
 * being visible, or by recent interaction — a buried, silent, untouched tab
 * sends nothing and the database is free to sleep.
 *
 * Playing audio always counts, even hidden: listening from a pocket is using.
 */

const IDLE_MS = 15 * 60 * 1000;

let lastInteract = 0;
let listening = false;

function ensureListening(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  const stamp = () => {
    lastInteract = Date.now();
  };
  stamp();
  window.addEventListener("pointerdown", stamp, { passive: true });
  window.addEventListener("keydown", stamp);
}

export function shouldHeartbeat(isPlaying: boolean): boolean {
  ensureListening();
  if (isPlaying) return true;
  if (typeof document !== "undefined" && document.hidden) return false;
  return Date.now() - lastInteract < IDLE_MS;
}
