import webpush from "web-push";
import prisma from "@/lib/prisma";

function vapid() {
  const pub = process.env.VAPID_PUBLIC_KEY || "";
  const priv = process.env.VAPID_PRIVATE_KEY || "";
  if (!pub || !priv) return null;
  return { pub, priv };
}

export function vapidPublicKey(): string | null {
  return vapid()?.pub ?? null;
}

// Fan a push notification out to every admin device subscription.
// Best-effort per endpoint: gone subscriptions (410/404) are pruned.
export async function pushToAdmins(title: string, body: string, url = "/admin"): Promise<void> {
  const v = vapid();
  if (!v) {
    console.error("Push skipped: VAPID keys not configured");
    return;
  }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:admin@example.com",
    v.pub,
    v.priv
  );
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
