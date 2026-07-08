// mapjson-ontology worker — served publicly through api.mapjson.com, which
// forwards /v1/resolve, /v1/feedback, /v1/entities/*, /v1/curation/* and
// /v1/health here via a service binding (see ../mapjson/worker).
//
// The resolver index is bundled into the script (imported JSON), so it parses
// under the isolate startup budget instead of the per-request CPU budget, and
// index updates deploy atomically with code. When world-ADM2 shards land they
// will load lazily from R2; this hot shard stays bundled.

import hot from "./generated/hot.json";
import { resolveBatch } from "./resolver.js";
import { buildGraph } from "./graph.js";
import { logResolution, logFeedback } from "./log.js";

const MAX_KEYS = 1000;
const VALID_LAYERS = new Set(["countries", "regions", "districts", "postal"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...headers },
  });

const badRequest = (error) => json({ error }, 400);

function parseContext(raw) {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("context must be an object");
  const ctx = {};
  if (raw.layer != null) {
    if (!VALID_LAYERS.has(raw.layer)) throw new Error(`context.layer must be one of: ${[...VALID_LAYERS].join(", ")}`);
    ctx.layer = raw.layer;
  }
  if (raw.country != null) ctx.country = String(raw.country).toUpperCase();
  if (raw.parent != null) ctx.parent = String(raw.parent).toUpperCase();
  return ctx;
}

async function handleResolve(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest("body must be JSON: {keys: [...], context: {...}}");
  }
  if (!Array.isArray(body.keys) || body.keys.length === 0) {
    return badRequest("keys must be a non-empty array");
  }
  if (body.keys.length > MAX_KEYS) {
    return badRequest(`too many keys (max ${MAX_KEYS})`);
  }
  let context;
  try {
    context = parseContext(body.context);
  } catch (err) {
    return badRequest(err.message);
  }

  const keys = body.keys.map((k) => String(k));
  const { consensus, results } = resolveBatch(hot, keys, context);
  const requestId = crypto.randomUUID();

  ctx.waitUntil(logResolution(env.DB, requestId, results, context));

  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;

  return json({ requestId, indexBuiltAt: hot.builtAt, consensus, counts, results });
}

async function handleFeedback(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest("body must be JSON: {key, wrong_gid?, correct_gid, note?}");
  }
  if (!body.key || !body.correct_gid) return badRequest("key and correct_gid are required");
  const correctGid = String(body.correct_gid);
  if (hot.gidIndex[correctGid] == null) return badRequest(`unknown correct_gid: ${correctGid}`);

  await logFeedback(env.DB, {
    key: body.key,
    wrongGid: body.wrong_gid != null ? String(body.wrong_gid) : null,
    correctGid,
    note: body.note != null ? String(body.note).slice(0, 500) : null,
  });
  return json({ ok: true, message: "thanks — this feeds the next index build" });
}

function handleEntity(gid) {
  const idx = hot.gidIndex[gid];
  if (idx == null) return json({ error: `unknown gid: ${gid}` }, 404);
  const e = hot.entities[idx];

  const identifiers = [];
  for (const [value, rows] of Object.entries(hot.identifiers)) {
    for (const [scheme, entityIdx] of rows) {
      if (entityIdx === idx) identifiers.push({ scheme, value });
    }
  }
  const names = [];
  for (const [norm, postings] of hot.names) {
    for (const [entityIdx, nameType, source] of postings) {
      if (entityIdx === idx) names.push({ name: norm, type: nameType, source });
    }
  }
  return json({ ...e, identifiers, names }, 200, { "Cache-Control": "public, max-age=86400" });
}

async function handleCurationQueue(request, env) {
  const url = new URL(request.url);
  if (!env.CURATION_TOKEN || url.searchParams.get("token") !== env.CURATION_TOKEN) {
    return json({ error: "unauthorized" }, 401);
  }
  const misses = await env.DB.prepare(
    `SELECT raw_key, status, COUNT(*) AS n, MAX(created_at) AS last_seen
     FROM resolution_log WHERE status IN ('miss','low_confidence','ambiguous')
     GROUP BY raw_key, status ORDER BY n DESC LIMIT 100`
  ).all();
  const feedback = await env.DB.prepare(
    `SELECT id, raw_key, wrong_gid, correct_gid, note, created_at
     FROM feedback WHERE curated_at IS NULL ORDER BY created_at DESC LIMIT 100`
  ).all();
  return json({ misses: misses.results, uncuratedFeedback: feedback.results });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Retired host — everything moved to api.mapjson.com / mapjson.com.
    if (url.hostname === "keys.mapjson.com") {
      return json({ error: "gone — this API moved to api.mapjson.com" }, 410);
    }

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (path === "/v1/resolve" && request.method === "POST") return handleResolve(request, env, ctx);
    if (path === "/v1/feedback" && request.method === "POST") return handleFeedback(request, env);
    if (path.startsWith("/v1/entities/") && request.method === "GET") {
      const rest = decodeURIComponent(path.slice("/v1/entities/".length));
      if (rest.endsWith("/graph")) {
        const gid = rest.slice(0, -"/graph".length);
        const depth = Math.min(Math.max(Number(url.searchParams.get("depth")) || 1, 1), 2);
        const graph = buildGraph(hot, gid, depth);
        if (!graph) return json({ error: `unknown gid: ${gid}` }, 404);
        return json(graph, 200, { "Cache-Control": "public, max-age=86400" });
      }
      return handleEntity(rest);
    }
    if (path === "/v1/curation/queue" && request.method === "GET") {
      return handleCurationQueue(request, env);
    }
    if (path === "/v1/health") {
      return json({ ok: true, indexBuiltAt: hot.builtAt, counts: hot.counts });
    }

    return json({ error: "Not found. See mapjson.com/docs/ for the API docs." }, 404);
  },
};
