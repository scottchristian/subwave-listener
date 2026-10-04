import webpush from "web-push";
import prisma from "@/lib/prisma";

// VAPID keys: DB first (Admin card), env fallback. Changing keys orphan
// existing device subscriptions (they're encrypted to the old pair) —
// devices re-subscribe on next admin visit, gone endpoints self-prune.
async function vapid(): Promise<{ pub: string; priv: string; subject: string } | null> {
  let pub = process.env.VAPID_PUBLIC_KEY || "";
  let priv = process.env.VAPID_PRIVATE_KEY || "";
  let subject = process.env.VAPID_SUBJECT || "mailto:admin@example.com";
  try {
    const rows = await prisma.setting.findMany({
      where: { key: { in: ["vapidPublicKey", "vapidPrivateKey", "vapidSubject"] } },
    });
    const get = (k: string) => rows.find((r) => r.key === k)?.value || "";
    pub = get("vapidPublicKey") || pub;
    priv = get("vapidPrivateKey") || priv;
    subject = get("vapidSubject") || subject;
  } catch {}
  if (!pub || !priv) return null;
  return { pub, priv, subject };
}

export async function vapidPublicKey(): Promise<string | null> {
  return (await vapid())?.pub ?? null;
}

// Per-admin opt-in for update news ("a new version is waiting", "updating
// now"). Update pushes used to fan out to every admin device; now each admin
// chooses in Admin → System → Software. Stored as one setting per user
// (`updateNotify:<userId>`) rather than a User column — no migration, same
// pattern as the other update preferences. Absent means out: it is opt-IN.
export const updateNotifyKey = (userId: string) => `updateNotify:${userId}`;

export async function isUpdateNotifyOptedIn(userId: string): Promise<boolean> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: updateNotifyKey(userId) } });
    return row?.value === "true";
  } catch {
    return false;
  }
}

/**
 * Update news, but only to admins who asked for it. Same delivery and pruning
 * as pushToAdmins — the only difference is the audience. Access requests and
 * other operational pushes stay on pushToAdmins (all admins, always).
 */
export async function pushUpdateToOptedIn(title: string, body: string, url = "/admin"): Promise<void> {
  const v = await vapid();
  if (!v) {
    console.error("Push skipped: VAPID keys not configured");
    return;
  }
  webpush.setVapidDetails(v.subject, v.pub, v.priv);
  const [subs, prefRows] = await Promise.all([
    prisma.pushSubscription.findMany({
      include: { user: { select: { id: true, isAdmin: true } } },
    }),
    prisma.setting.findMany({
      where: { key: { startsWith: "updateNotify:" }, value: "true" },
    }),
  ]);
  const optedIn = new Set(prefRows.map((r) => r.key.slice("updateNotify:".length)));
  const payload = JSON.stringify({ title, body, url });
  await Promise.all(
    subs
      .filter((s) => s.user?.isAdmin && optedIn.has(s.user.id))
      .map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload
          );
        } catch (e: any) {
          if (e?.statusCode === 404 || e?.statusCode === 410) {
            await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
          } else {
            console.error("Push send failed:", e?.message || e);
          }
        }
      })
  );
}
// Fan a push notification out to every admin device subscription.
// Best-effort per endpoint: gone subscriptions (410/404) are pruned.
export async function pushToAdmins(title: string, body: string, url = "/admin"): Promise<void> {
  const v = await vapid();
  if (!v) {
    console.error("Push skipped: VAPID keys not configured");
    return;
  }
  webpush.setVapidDetails(v.subject, v.pub, v.priv);
  const subs = await prisma.pushSubscription.findMany({
    include: { user: { select: { isAdmin: true } } },
  });
  const payload = JSON.stringify({ title, body, url });
  await Promise.all(
    subs
      .filter((s) => s.user?.isAdmin)
      .map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload
          );
        } catch (e: any) {
          if (e?.statusCode === 404 || e?.statusCode === 410) {
            await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
          } else {
            console.error("Push send failed:", e?.message || e);
          }
        }
      })
  );
}
