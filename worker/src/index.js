import { parseAndValidate } from './validate.js';
import { filterFeatures } from './filter.js';
import { mergeProperties } from './merge-props.js';
import { pruneArcs } from './prune-arcs.js';
import { feature } from 'topojson-client';

// Cache properties.json in memory for the lifetime of the Worker instance
let propsCache = null;

const DETAIL_TO_FILE = { low: 'low', medium: 'medium', high: 'high', ultra: 'high' };


const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extra },
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

// Resolve a country name (e.g. "Poland") to its ISO alpha-2 code using properties.json.
// Returns the iso2 string if found, or null if the name is unknown.
async function resolveNameToIso2(name, bucket) {
  const props = await getProps(bucket);
  const lower = name.toLowerCase();
  for (const entry of Object.values(props)) {
    if (entry.name?.toLowerCase() === lower || entry.nameOfficial?.toLowerCase() === lower) {
      return entry.iso2;
    }
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
    const iso2 = await resolveNameToIso2(filter, env.GEO_BUCKET);
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

  // Convert to GeoJSON if requested
  if (format === 'geojson') {
    const geojson = feature(topo, topo.objects.geo);
    return json(geojson, 200, { 'Cache-Control': 'public, max-age=3600' });
  }

  return json(topo, 200, { 'Cache-Control': 'public, max-age=3600' });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === '/v1/geo') {
      return handleGeo(request, env).catch((err) => {
        console.error(err);
        return error('Internal server error', 500);
      });
    }

    if (url.pathname === '/v1/catalog') {
      return handleCatalog(request, env).catch((err) => {
        console.error(err);
        return error('Internal server error', 500);
      });
    }

    if (url.pathname === '/') {
      return new Response('mapjson API — see https://mapjson.com', { headers: CORS });
    }

    return error('Not found', 404);
  },
};
