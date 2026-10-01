import { getSubwaveConfig, subwaveAdminAuth } from "@/lib/subwave";

// Read-only view of the Sub/Wave DJ skills, for the listener-facing panel.
//
// The upstream catalogue is the operator's control surface, and most of it must
// not travel to a browser: cooldownMs, requiresKey, keyUrl, hint, contextFields,
// voice, cron and cohosts are behaviour dials, and `description` is not a
// summary at all — it is the skill's entire markdown brief, which is the prompt
// handed to the DJ agent. So the shape crossing this boundary is deliberately
// tiny (name / label / a trimmed description) rather than a pass-through.

/**
 * What a listener is allowed to see about a skill.
 *
 * `description` is the skill's markdown brief — the same text Sub/Wave's own
 * admin roster renders to the operator, clamped with line-clamp. It is included
 * because it is what tells a listener what they are about to put on air, and the
 * drill-down needs it. It travels and renders as plain text; there is no
 * markdown rendering anywhere on this path, so a brief cannot inject markup.
 *
 * Behaviour dials are still withheld — cooldown, requiresKey, keyUrl, hint,
 * contextFields, voice, cron, cohosts, tags. Those are operator settings, not
 * something a listener needs in order to press Run.
 */
export interface SkillSummary {
  name: string;
  label: string;
  description: string;
}

/** Sanity bound on a brief. The real ones run 150–800 chars. */
const DESC_MAX = 1200;

export type CatalogResult =
  | { ok: true; skills: SkillSummary[] }
  | { ok: false; status: number; error: string };

/**
 * Fetch the skill catalogue from Sub/Wave.
 *
 * Only skills that are switched on AND runnable are returned:
 *   - `enabled: false` — deliberately off for this station. A manual run
 *     ignores that toggle, so including them would offer listeners a button
 *     the station has switched off.
 *   - `ready: false` — a required API key is missing; running it throws a 500.
 *
 * Between them this doubles as the allowlist: switching a skill off in Sub/Wave
 * is how it stops being offered here, with no second list to keep in sync.
 */
export async function fetchSkillCatalog(): Promise<CatalogResult> {
  const cfg = await getSubwaveConfig();
  if (!cfg.apiUrl) {
    return { ok: false, status: 500, error: "Sub/Wave server URL is not configured." };
  }
  const auth = subwaveAdminAuth(cfg);
  if (!auth) {
    return {
      ok: false,
      status: 500,
      error: "Sub/Wave server credentials are not configured (Admin → Sub/Wave Server).",
    };
  }

  let res: Response;
  try {
    res = await fetch(`${cfg.apiUrl}/dj/skills`, {
      headers: { authorization: auth },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
  } catch {
    return { ok: false, status: 502, error: "Could not reach the Sub/Wave server." };
  }
  if (!res.ok) {
    return { ok: false, status: 502, error: `Sub/Wave server returned ${res.status}.` };
  }

  const data = await res.json().catch(() => null);
  const raw: unknown[] = Array.isArray((data as any)?.skills) ? (data as any).skills : [];
  const skills = raw
    .filter((s: any) => s && typeof s.name === "string" && s.name.length > 0)
    .filter((s: any) => s.enabled === true && s.ready !== false)
    .map((s: any) => ({
      name: String(s.name),
      label: String(s.label || s.name),
      description:
        typeof s.description === "string" ? s.description.slice(0, DESC_MAX) : "",
    }));
  return { ok: true, skills };
}

/**
 * Look up one offered skill by name, or null.
 *
 * The run route uses this so the name it forwards is never a raw
 * caller-supplied string, and so the row records the operator's own label rather
 * than the slug. Returns null for a skill that is switched off, not runnable, or
 * no longer exists — each of which should stop a run immediately rather than at
 * the next deploy.
 */
export async function findOfferedSkill(name: unknown): Promise<SkillSummary | null> {
  if (typeof name !== "string" || name.length === 0) return null;
  const catalog = await fetchSkillCatalog();
  if (!catalog.ok) return null;
  return catalog.skills.find((s) => s.name === name) ?? null;
}