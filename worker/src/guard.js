/**
 * Abuse protection + usage metering for the mapjson API.
 *
 * Layers (cheapest first — most requests only touch in-isolate caches):
 *   1. Kill switch  — KV key `service:paused` (checked ≤1×/min per isolate) → 503 everywhere.
 *                     Flip on:  wrangler kv key put service:paused 1 --namespace-id <GUARD>
 *                     Flip off: wrangler kv key delete service:paused --namespace-id <GUARD>
 *                     The cron also flips it automatically when the whole service exceeds
 *                     GLOBAL_DAILY_CALLS in 24h (with a 1h TTL, so it self-resets and only
 *                     stays down while traffic remains over budget).
 *   2. Ban list     — KV key `ban:<ip>` (TTL = automatic reset) → 403. Written either by the
 *                     strike escalation below or by the cron's daily-budget sweep.
 *   3. Rate limit   — LIMITER binding, per-IP per-colo (RATE_LIMIT req / RATE_PERIOD s) → 429.
 *                     Each rejected request adds a strike (`strike:<ip>`, 1h TTL); an IP that
 *                     keeps hammering through 429s (≥ STRIKE_BAN 429s in an hour) gets a
 *                     BAN_TTL_S ban. Honest clients that back off never escalate.
 *   4. Metering     — Workers Analytics Engine dataset `mapjson_usage`: one point per request
 *                     (ip, path, layer, bytes). Query with worker/report-usage.js.
 *
 * The cron (scheduled handler) enforces 24h budgets from the metering data. It needs two
 * secrets to talk to the Analytics Engine SQL API — until they are set it logs and skips:
 *   wrangler secret put CF_ACCOUNT_ID        (dash → Workers & Pages → account id)
 *   wrangler secret put CF_ANALYTICS_TOKEN   (API token with Account Analytics: Read)
 */

const KILL_CACHE_MS = 60_000;   // how long an isolate trusts its cached kill-switch value
const BAN_CACHE_MS = 60_000;    // how long an isolate caches a per-IP ban lookup
const STRIKE_BAN = 30;          // 429s within an hour that convert into a ban
const STRIKE_TTL_S = 3600;
const BAN_TTL_S = 86_400;       // 24h — expiry IS the reset
const DAILY_CALL_BUDGET = 50_000;         // per-IP calls / 24h before the cron bans
const DAILY_BYTE_BUDGET = 2e9;            // per-IP bytes / 24h before the cron bans
const GLOBAL_DAILY_CALLS = 5_000_000;     // whole-service calls / 24h before auto-pause

let killCache = { paused: false, at: 0 };
const banCache = new Map(); // ip -> { banned, at }

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || '0.0.0.0';
}

function guardResponse(status, message, extra = {}) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...extra },
  });
}

// Returns a Response to short-circuit with, or null to continue serving.
export async function checkGuards(request, env, ctx) {
  if (!env.GUARD) return null; // guards not configured — never break the API over them

  // 1. kill switch (cached per isolate)
  const now = Date.now();
  if (now - killCache.at > KILL_CACHE_MS) {
    killCache = { paused: !!(await env.GUARD.get('service:paused')), at: now };
  }
  if (killCache.paused) {
    return guardResponse(503, 'mapjson is temporarily paused due to unusual load — try again later', { 'Retry-After': '3600' });
  }

  const ip = clientIp(request);

  // 2. ban list (cached per isolate per ip)
  const cached = banCache.get(ip);
  let banned;
  if (cached && now - cached.at < BAN_CACHE_MS) {
    banned = cached.banned;
  } else {
    banned = !!(await env.GUARD.get(`ban:${ip}`));
    banCache.set(ip, { banned, at: now });
    if (banCache.size > 10_000) banCache.clear(); // crude memory cap; refills on demand
  }
  if (banned) {
    return guardResponse(403, 'this IP is temporarily blocked for exceeding rate limits — resets within 24h', { 'Retry-After': String(BAN_TTL_S) });
  }

  // 3. rate limit (per-colo)
  if (env.LIMITER) {
    const { success } = await env.LIMITER.limit({ key: ip });
    if (!success) {
      ctx.waitUntil(recordStrike(env, ip)); // escalation off the hot path
      return guardResponse(429, 'rate limit exceeded — slow down', { 'Retry-After': '60' });
    }
  }

  return null;
}

// A 429'd request that keeps coming back earns strikes; enough strikes become a ban.
// KV read-modify-write is racy across colos — undercounting slightly is fine here.
async function recordStrike(env, ip) {
  try {
    const n = parseInt(await env.GUARD.get(`strike:${ip}`), 10) || 0;
    await env.GUARD.put(`strike:${ip}`, String(n + 1), { expirationTtl: STRIKE_TTL_S });
    if (n + 1 >= STRIKE_BAN) {
      await env.GUARD.put(`ban:${ip}`, JSON.stringify({ at: new Date().toISOString(), reason: 'rate-limit strikes' }), { expirationTtl: BAN_TTL_S });
    }
  } catch (e) {
    console.error('strike escalation failed', e);
  }
}

// One analytics point per request: who, what, how many bytes.
export function meter(env, request, response) {
  if (!env.USAGE) return;
  try {
    const url = new URL(request.url);
    const bytes = parseInt(response.headers.get('X-Content-Bytes'), 10) || 0;
    const ip = clientIp(request);
    env.USAGE.writeDataPoint({
      indexes: [ip],
      blobs: [ip, url.pathname, url.searchParams.get('layer') || url.searchParams.get('type') || ''],
      doubles: [1, bytes, response.status],
    });
  } catch (e) {
    console.error('metering failed', e);
  }
}

// ── cron: enforce 24h budgets from the metering data ────────────────────────
async function waeSql(env, sql) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` },
    body: sql,
  });
  if (!r.ok) throw new Error(`WAE SQL ${r.status}: ${await r.text()}`);
  return (await r.json()).data || [];
}

export async function enforceBudgets(env) {
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) {
    console.log('budget cron: CF_ACCOUNT_ID / CF_ANALYTICS_TOKEN secrets not set — skipping');
    return;
  }

  // per-IP daily budget → 24h ban
  const heavy = await waeSql(env, `
    SELECT blob1 AS ip,
           SUM(_sample_interval) AS calls,
           SUM(double2 * _sample_interval) AS bytes
    FROM mapjson_usage
    WHERE timestamp > NOW() - INTERVAL '24' HOUR
    GROUP BY ip
    HAVING calls > ${DAILY_CALL_BUDGET} OR bytes > ${DAILY_BYTE_BUDGET}
  `);
  for (const row of heavy) {
    await env.GUARD.put(`ban:${row.ip}`, JSON.stringify({ at: new Date().toISOString(), reason: 'daily budget', calls: row.calls, bytes: row.bytes }), { expirationTtl: BAN_TTL_S });
    console.log(`budget cron: banned ${row.ip} (${row.calls} calls, ${(row.bytes / 1e6).toFixed(0)} MB in 24h)`);
  }

  // whole-service budget → auto-pause for 1h (re-applied each cron while still over)
  const [total] = await waeSql(env, `
    SELECT SUM(_sample_interval) AS calls
    FROM mapjson_usage
    WHERE timestamp > NOW() - INTERVAL '24' HOUR
  `);
  if (total && total.calls > GLOBAL_DAILY_CALLS) {
    await env.GUARD.put('service:paused', '1', { expirationTtl: 3600 });
    console.log(`budget cron: SERVICE PAUSED — ${total.calls} calls in 24h exceeds ${GLOBAL_DAILY_CALLS}`);
  }
}
