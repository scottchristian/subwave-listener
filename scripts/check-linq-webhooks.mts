// Linq webhook subscriptions: the admin panel creates the subscription and
// stores the signing secret, because Linq shows the secret once. These are the
// request shapes that make that work — URL, method, auth, body — plus the
// error mapping the panel surfaces, driven against a fake fetch.
//
// Run: node --import ./scripts/test-register.mjs scripts/check-linq-webhooks.mts
// (wired as `npm run check:linq-webhooks`)
import {
  createWebhookSubscription,
  deleteWebhookSubscription,
  listWebhookSubscriptions,
  WEBHOOK_EVENT,
} from "../lib/linq.ts";

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string, detail?: unknown) {
  if (cond) passed++;
  else {
    failed++;
    console.log(`  FAIL  ${name}${detail === undefined ? "" : ` (got ${JSON.stringify(detail)})`}`);
  }
}

const SAVED = {
  LINQ_ENABLED: process.env.LINQ_ENABLED,
  LINQ_API_KEY: process.env.LINQ_API_KEY,
  LINQ_API_BASE: process.env.LINQ_API_BASE,
};
const BASE = "https://linq.test/api/partner/v3";
process.env.LINQ_ENABLED = "1";
process.env.LINQ_API_KEY = "linq_test_key";
process.env.LINQ_API_BASE = BASE;

type Reply = { status?: number; body?: unknown };
function fakeFetch(reply: Reply | ((url: string, init: any) => Reply)) {
  const calls: { url: string; init: any }[] = [];
  const f = (async (url: any, init: any = {}) => {
    calls.push({ url: String(url), init });
    const r = typeof reply === "function" ? reply(String(url), init) : reply;
    const body = r.body === undefined ? "" : JSON.stringify(r.body);
    return new Response(body, { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl: f, calls };
}

// ---- list -----------------------------------------------------------------
{
  const { fetchImpl, calls } = fakeFetch({
    body: {
      subscriptions: [
        {
          id: "sub_1",
          target_url: "https://station.test/api/linq/webhook",
          subscribed_events: ["message.received"],
          is_active: true,
        },
      ],
    },
  });
  const res = await listWebhookSubscriptions({ fetchImpl });
  ok(res.ok, "list succeeds on 200");
  ok(calls[0]?.url === `${BASE}/webhook-subscriptions`, "list calls the subscriptions path", calls[0]?.url);
  ok(calls[0]?.init?.method === "GET", "list uses GET", calls[0]?.init?.method);
  ok(calls[0]?.init?.headers?.Authorization === "Bearer linq_test_key", "list sends the bearer key");
  ok(calls[0]?.init?.body === undefined, "list sends no body");
  if (res.ok) {
    ok(res.subscriptions.length === 1, "list returns one subscription");
    ok(res.subscriptions[0]?.id === "sub_1", "list maps id");
    ok(res.subscriptions[0]?.targetUrl === "https://station.test/api/linq/webhook", "list maps target_url");
    ok(res.subscriptions[0]?.events.join() === "message.received", "list maps subscribed_events");
    ok(res.subscriptions[0]?.active === true, "list maps is_active");
  }
}
{
  const { fetchImpl } = fakeFetch({ body: {} });
  const res = await listWebhookSubscriptions({ fetchImpl });
  ok(res.ok && res.subscriptions.length === 0, "list treats a missing subscriptions array as empty");
}

// ---- create ---------------------------------------------------------------
{
  const { fetchImpl, calls } = fakeFetch({
    body: { id: "sub_new", signing_secret: "whsec_test", is_active: true },
  });
  const url = "https://station.test/api/linq/webhook";
  const res = await createWebhookSubscription(url, { fetchImpl });
  ok(calls[0]?.url === `${BASE}/webhook-subscriptions`, "create posts to the subscriptions path");
  ok(calls[0]?.init?.method === "POST", "create uses POST");
  ok(calls[0]?.init?.headers?.["Content-Type"] === "application/json", "create sends JSON");
  const body = JSON.parse(String(calls[0]?.init?.body ?? "{}"));
  ok(body.target_url === url, "create sends target_url", body.target_url);
  ok(
    Array.isArray(body.subscribed_events) && body.subscribed_events.length === 1 && body.subscribed_events[0] === WEBHOOK_EVENT,
    "create subscribes only to message.received",
    body.subscribed_events
  );
  ok(res.ok && res.id === "sub_new" && res.signingSecret === "whsec_test", "create returns the id and signing secret");
}
{
  const { fetchImpl } = fakeFetch({ body: { id: "sub_new" } });
  const res = await createWebhookSubscription("https://station.test/api/linq/webhook", { fetchImpl });
  ok(!res.ok, "create fails when Linq returns no signing secret");
}
{
  const { fetchImpl } = fakeFetch({ status: 401, body: { error: { code: 2004 } } });
  const res = await createWebhookSubscription("https://station.test/api/linq/webhook", { fetchImpl });
  ok(!res.ok && res.status === 401, "create keeps the upstream status", res.ok ? "ok" : res.status);
  ok(!res.ok && /401/.test(res.error), "create names the status in the error", res.ok ? "ok" : res.error);
}
{
  const { fetchImpl } = fakeFetch(() => {
    throw new DOMException("timed out", "TimeoutError");
  });
  const res = await listWebhookSubscriptions({ fetchImpl });
  ok(!res.ok && res.error.includes("timeout"), "a timeout is reported as timeout", res.ok ? "ok" : res.error);
}

// ---- delete ---------------------------------------------------------------
{
  const { fetchImpl, calls } = fakeFetch({ body: { success: true } });
  const res = await deleteWebhookSubscription("sub/1 2", { fetchImpl });
  ok(res.ok, "delete succeeds on 200");
  ok(
    calls[0]?.url === `${BASE}/webhook-subscriptions/sub%2F1%202`,
    "delete encodes the subscription id",
    calls[0]?.url
  );
  ok(calls[0]?.init?.method === "DELETE", "delete uses DELETE");
}
{
  const { fetchImpl } = fakeFetch({ status: 404, body: {} });
  const res = await deleteWebhookSubscription("gone", { fetchImpl });
  ok(res.ok, "delete treats an already-gone subscription as done");
}

// ---- no key ---------------------------------------------------------------
{
  delete process.env.LINQ_API_KEY;
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response("{}");
  }) as unknown as typeof fetch;
  const res = await listWebhookSubscriptions({ fetchImpl });
  ok(!res.ok && res.error === "no API key saved", "no key fails before any request", res.ok ? "ok" : res.error);
  ok(!called, "no key means no network call");
  process.env.LINQ_API_KEY = "linq_test_key";
}

// ---- restore --------------------------------------------------------------
for (const [k, v] of Object.entries(SAVED)) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

console.log(`  ${passed}/${passed + failed} Linq webhook assertions passed`);
if (failed) process.exit(1);
