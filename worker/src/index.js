import { parseAndValidate } from './validate.js';
import { filterFeatures } from './filter.js';
import { mergeProperties } from './merge-props.js';
import { pruneArcs } from './prune-arcs.js';
import { checkGuards, meter, enforceBudgets } from './guard.js';
import { feature } from 'topojson-client';

// Cache properties.json in memory for the lifetime of the Worker instance
let propsCache = null;
// Cache each points FeatureCollection (points/{type}.json) per Worker instance
const pointsCache = {};
// Cache the countries catalog (with minDetail) for the detail-discoverability hints
let countryCatalogCache = null;

const DETAIL_TO_FILE = { low: 'low', medium: 'medium', high: 'high', ultra: 'high' };
const DETAIL_RANK    = { low: 0, medium: 1, high: 2, ultra: 2 };
// Continent filter slug → the continent name stored in the catalog (scopes `omitted`)
const CONTINENT_NAME = {
  europe: 'Europe', asia: 'Asia', africa: 'Africa',
  'north-america': 'North America', 'south-america': 'South America',
  oceania: 'Oceania', antarctica: 'Antarctica',
};


const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200, extra = {}) {
  const body = JSON.stringify(data);
  return new Response(body, {
    status,
    // X-Content-Bytes feeds the usage metering (see guard.js) — body size before compression
    headers: { 'Content-Type': 'application/json', 'X-Content-Bytes': String(body.length), ...CORS, ...extra },
  });
}

function error(msg, status = 400) {
  return json({ error: msg }, status);
}

async function getProps(bucket) {
  if (!propsCache) {
    const obj = await bucket.get('properties.json');
    if (!obj) throw new Error('properties.json not found in R2');
    propsCache = await obj.json();
  }
  return propsCache;
}

const CONTINENT_SLUGS = new Set(['world', 'europe', 'asia', 'africa', 'north-america', 'south-america', 'oceania', 'antarctica']);
const ISO2_RE_LOCAL   = /^[A-Z]{2}$/;

// Point datasets served from /v1/points (geojson FeatureCollections in R2 at points/{type}.json)
const POINT_TYPES = new Set(['city']);
const POINT_CONTINENT = {
  europe: 'Europe', asia: 'Asia', africa: 'Africa',
  'north-america': 'North America', 'south-america': 'South America',
  oceania: 'Oceania', antarctica: 'Antarctica',
};

// Resolve a country name (e.g. "Poland") to its ISO alpha-2 code.
// Fast path: exact match on properties.json name/nameOfficial (no subrequest).
// Fallback: the ontology resolver, which knows the exonyms and aliases the two-field
// match misses ("Cape Verde", "Holland", "Türkiye", "South Korea"…). Null if unknown.
async function resolveNameToIso2(name, env) {
  const props = await getProps(env.GEO_BUCKET);
  const lower = name.toLowerCase();
  for (const entry of Object.values(props)) {
    if (entry.name?.toLowerCase() === lower || entry.nameOfficial?.toLowerCase() === lower) {
      return entry.iso2;
    }
  }
  return resolveViaOntology(name, env);
}

// Ask the ontology worker (service binding) to resolve a place name to a country iso2.
// Only accepts a confident country match so a fuzzy guess can't silently swap the map.
async function resolveViaOntology(name, env) {
  if (!env.ONTOLOGY) return null;
  try {
    const res = await env.ONTOLOGY.fetch(new Request('https://ontology.internal/v1/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [name], context: { layer: 'countries' } }),
    }));
    if (!res.ok) return null;
    const data = await res.json();
    const r = data.results?.[0];
    if (r && r.status === 'resolved' && r.layer === 'countries' && r.confidence >= 0.8) {
      return r.crosswalk?.iso2 || (/^[A-Z]{2}$/.test(r.gid) ? r.gid : null);
    }
  } catch (err) {
    console.error('ontology resolve failed', err);
  }
  return null;
}

// Countries catalog keyed by iso2 — carries minDetail for the detail-discoverability hints.
async function getCountryCatalog(bucket) {
  if (!countryCatalogCache) {
    const obj = await bucket.get('catalog/countries.json');
    if (!obj) return null;
    const list = await obj.json();
    countryCatalogCache = { list, byIso2: new Map(list.map((e) => [e.iso2, e])) };
  }
  return countryCatalogCache;
}

// Detail-discoverability hints for a countries request. Small nations (e.g. Cabo Verde)
// are absent from coarser tiers, so:
//   notice   — a single-country filter that resolved but came back empty at this detail
//   omitted  — a world/continent request; lists the countries that only exist deeper
async function detailHints(bucket, filter, detail, featureCount) {
  const cat = await getCountryCatalog(bucket);
  if (!cat) return null;
  const reqRank = DETAIL_RANK[detail];
  const deeper = (e) => e.minDetail && DETAIL_RANK[e.minDetail] > reqRank;

  if (/^[A-Z]{2}$/.test(filter)) {
    if (featureCount > 0) return null;
    const e = cat.byIso2.get(filter);
    if (e && deeper(e)) {
      return { notice: { code: 'detail_too_low', iso2: e.iso2, name: e.name, minDetail: e.minDetail,
                         hint: `${e.name} is only available at detail=${e.minDetail} or higher` } };
    }
    return null;
  }

  const cont = CONTINENT_NAME[filter];
  if (filter === 'world' || cont) {
    const omitted = cat.list
      .filter((e) => deeper(e) && (filter === 'world' || e.continent === cont))
      .map((e) => ({ iso2: e.iso2, name: e.name, minDetail: e.minDetail }));
    if (omitted.length) return { omitted };
  }
  return null;
}

async function handleCatalog(request, env) {
  const q = new URL(request.url).searchParams;
  const layer  = q.get('layer')  || 'countries';
  const filter = q.get('filter') ? q.get('filter').toUpperCase() : null;

  if (!['countries', 'regions', 'districts', 'postal'].includes(layer)) {
    return error(`layer must be one of: countries, regions, districts, postal`);
  }
  if ((layer === 'regions' || layer === 'districts' || layer === 'postal') && !filter) {
    return error(`${layer} catalog requires a filter — add ?filter=PL (ISO alpha-2 code)${layer === 'postal' ? ' or ?filter=US-MA (state code)' : ''}`);
  }

  const obj = await env.GEO_BUCKET.get(`catalog/${layer}.json`);
  if (!obj) return error(`No catalog for layer='${layer}'`, 404);

  if (!filter) {
    return new Response(await obj.text(), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...CORS, 'Cache-Control': 'public, max-age=86400' },
    });
  }

  const all = await obj.json();
  // regions:   parent_gid is the country ISO2 (e.g. PL)
  // districts: filter by parent_gid when given a region code (US-MA),
  //            or by iso2 when given a country code (US)
  const filtered = layer === 'regions'
    ? all.filter(e => e.parent_gid === filter)
    : filter.includes('-')
      ? all.filter(e => e.parent_gid === filter)
      : all.filter(e => e.iso2 === filter);

  return new Response(JSON.stringify(filtered), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS, 'Cache-Control': 'public, max-age=86400' },
  });
}

async function handleGeo(request, env) {
  const result = parseAndValidate(request.url);
  if (!result.ok) return error(result.errors.join('; '));

  let { layer, filter, detail, format, properties } = result.params;

  // Resolve country name → ISO2. Region codes (US-MA) pass through as-is.
  const ISO3166_2_RE_LOCAL = /^[A-Z]{2}-[A-Z0-9]+$/;
  if (!CONTINENT_SLUGS.has(filter) && !ISO2_RE_LOCAL.test(filter) && !ISO3166_2_RE_LOCAL.test(filter)) {
    const iso2 = await resolveNameToIso2(filter, env);
    if (!iso2) return error(`Unknown filter '${filter}' — use a continent slug, ISO alpha-2 code, ISO 3166-2 region code (e.g. US-MA), or country name`, 400);
    filter = iso2;
  }

  // Postal (ZCTA) files are pre-split per state — serve directly, no filtering,
  // no property merge (features already carry gid/parent_gid/iso2), no pruning.
  // The detail parameter is ignored: one 1:500k-generalized version per state.
  if (layer === 'postal') {
    const obj = await env.GEO_BUCKET.get(`postal/${filter}.topojson`);
    if (!obj) return error(`No postal data for '${filter}' — use a US state code (e.g. filter=US-MA)`, 404);
    const topo = await obj.json();
    const objectKey = Object.keys(topo.objects)[0];
    if (objectKey !== 'geo') {
      topo.objects.geo = topo.objects[objectKey];
      delete topo.objects[objectKey];
    }
    if (format === 'geojson') {
      return json(feature(topo, topo.objects.geo), 200, { 'Cache-Control': 'public, max-age=3600' });
    }
    return json(topo, 200, { 'Cache-Control': 'public, max-age=3600' });
  }

  const fileDetail = DETAIL_TO_FILE[detail];
  const r2Layer = layer === 'regions' ? 'admin1' : layer;

  // For ISO2 filter + high detail, try a per-country high-res file before the global 10m file.
  // These cover small countries/territories that are too small for Natural Earth 10m.
  const ISO2_RE = /^[A-Z]{2}$/;
  if (ISO2_RE.test(filter) && fileDetail === 'high' && (layer === 'countries' || layer === 'regions')) {
    const isoObj = await env.GEO_BUCKET.get(`${r2Layer}/iso/${filter}.topojson`);
    if (isoObj) {
      const topo = await isoObj.json();
      const objectKey = Object.keys(topo.objects)[0];
      if (layer === 'countries') {
        const props = await getProps(env.GEO_BUCKET);
        mergeProperties(topo, objectKey, props, properties);
      }
      if (objectKey !== 'geo') {
        topo.objects.geo = topo.objects[objectKey];
        delete topo.objects[objectKey];
      }
      if (format === 'geojson') {
        return json(feature(topo, topo.objects.geo), 200, { 'Cache-Control': 'public, max-age=3600' });
      }
      return json(topo, 200, { 'Cache-Control': 'public, max-age=3600' });
    }
    // No per-country file — fall through to global 10m handling below
  }

  // Global topojson files (standard path)
  // districts is always served from high.topojson — NE only has 10m admin2 data
  const r2Key = layer === 'countries' || layer === 'regions'
    ? `${r2Layer}/${fileDetail}.topojson`
    : layer === 'districts'
    ? 'districts/high.topojson'
    : `physical/${layer}/${fileDetail}.topojson`;

  const obj = await env.GEO_BUCKET.get(r2Key);
  if (!obj) return error(`No data for layer='${layer}' detail='${detail}'`, 404);

  const topo = await obj.json();
  const objectKey = Object.keys(topo.objects)[0];

  filterFeatures(topo, objectKey, { filter, layer });

  // Merge properties for countries layer only (regions embed name in base topojson)
  if (layer === 'countries') {
    const props = await getProps(env.GEO_BUCKET);
    mergeProperties(topo, objectKey, props, properties);
  }

  // For topojson responses, remove arcs that are no longer referenced by any
  // remaining feature — this is what makes single-country topojson smaller than GeoJSON.
  if (format !== 'geojson') {
    pruneArcs(topo, objectKey);
  }

  // Normalize object key to "geo" so clients always use topo.objects.geo
  if (objectKey !== 'geo') {
    topo.objects.geo = topo.objects[objectKey];
    delete topo.objects[objectKey];
  }

  // Detail-discoverability hints (countries only): a top-level `notice` when a resolved
  // single-country request is empty at this detail, or an `omitted` list on world/continent
  // requests. Foreign members are valid in both TopoJSON and GeoJSON, so they ride along
  // on whichever root we return.
  const featureCount = (topo.objects.geo.geometries || []).length;
  const hints = layer === 'countries'
    ? await detailHints(env.GEO_BUCKET, filter, detail, featureCount)
    : null;

  const out = format === 'geojson' ? feature(topo, topo.objects.geo) : topo;
  if (hints?.notice) out.notice = hints.notice;
  if (hints?.omitted) out.omitted = hints.omitted;
  return json(out, 200, { 'Cache-Control': 'public, max-age=3600' });
}

// Point features (cities, and later airports/hospitals/…). Served as GeoJSON only —
// points have no shared arcs, so topojson buys nothing. `filter` reuses the same
// grammar as /v1/geo: world | continent slug | ISO2 | ISO 3166-2 region | country name.
async function handlePoints(request, env) {
  const q = new URL(request.url).searchParams;
  const type = (q.get('type') || 'city').toLowerCase();
  const filter = q.get('filter') || 'world';
  const format = (q.get('format') || 'geojson').toLowerCase();

  if (!POINT_TYPES.has(type)) {
    return error(`type must be one of: ${[...POINT_TYPES].join(', ')}`);
  }
  if (format !== 'geojson') {
    return error('points are only available as geojson — omit format or set format=geojson');
  }

  const fLower = filter.toLowerCase();
  const fUpper = filter.toUpperCase();
  const isWorld     = fLower === 'world';
  const isContinent = Object.prototype.hasOwnProperty.call(POINT_CONTINENT, fLower);
  const isRegion    = /^[A-Z]{2}-[A-Z0-9]+$/.test(fUpper);
  const isIso2      = ISO2_RE_LOCAL.test(fUpper);

  // Resolve a country name → ISO2. world/continents/region codes/iso2 pass through.
  let iso2Filter = fUpper;
  if (!isWorld && !isContinent && !isRegion && !isIso2) {
    const resolved = await resolveNameToIso2(filter, env);
    if (!resolved) {
      return error(`Unknown filter '${filter}' — use world, a continent slug, ISO alpha-2 code, ISO 3166-2 region code (e.g. US-MA), or country name`);
    }
    iso2Filter = resolved;
  }

  if (!pointsCache[type]) {
    const obj = await env.GEO_BUCKET.get(`points/${type}.json`);
    if (!obj) return error(`No points for type='${type}'`, 404);
    pointsCache[type] = await obj.json();
  }

  let features = pointsCache[type].features;
  if (isContinent) {
    const cont = POINT_CONTINENT[fLower];
    features = features.filter((f) => f.properties.continent === cont);
  } else if (isRegion) {
    features = features.filter((f) => f.properties.region === fUpper);
  } else if (!isWorld) {
    features = features.filter((f) => f.properties.countryIso2 === iso2Filter);
  }

  return json({ type: 'FeatureCollection', features }, 200, { 'Cache-Control': 'public, max-age=3600' });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    // Key-resolution endpoints live in the separate mapjson-ontology worker,
    // reached via service binding. Forwarded before the OPTIONS handler so
    // preflight responses advertise POST (this worker's CORS is GET-only).
    // Non-preflight ontology requests go through the same abuse guards.
    if (p === '/v1/resolve' || p === '/v1/feedback' || p === '/v1/health' ||
        p.startsWith('/v1/entities/') || p.startsWith('/v1/curation/')) {
      if (request.method !== 'OPTIONS') {
        const blocked = await checkGuards(request, env, ctx);
        if (blocked) return blocked;
      }
      return env.ONTOLOGY.fetch(request);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // Abuse guards: kill switch → ban list → per-IP rate limit (see guard.js).
    // OPTIONS is exempt (cheap, and browsers need preflights to succeed).
    const blocked = await checkGuards(request, env, ctx);
    if (blocked) return blocked;

    const route =
      p === '/v1/geo' ? handleGeo :
      p === '/v1/catalog' ? handleCatalog :
      p === '/v1/points' ? handlePoints : null;

    if (route) {
      const res = await route(request, env).catch((err) => {
        console.error(err);
        return error('Internal server error', 500);
      });
      meter(env, request, res);   // usage analytics: ip, endpoint, bytes (see guard.js)
      return res;
    }

    if (p === '/') {
      return new Response('mapjson API — see https://mapjson.com', { headers: CORS });
    }

    return error('Not found', 404);
  },

  // Budget enforcement from the metering data (per-IP bans + service auto-pause).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(enforceBudgets(env).catch((e) => console.error('budget cron failed', e)));
  },
};
