import { parseAndValidate } from './validate.js';
import { filterFeatures } from './filter.js';
import { mergeProperties } from './merge-props.js';
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

async function handleGeo(request, env) {
  const result = parseAndValidate(request.url);
  if (!result.ok) return error(result.errors.join('; '));

  const { layer, filter, detail, format, properties } = result.params;

  // Geometry layers — fetch topojson from R2
  const fileDetail = DETAIL_TO_FILE[detail];
  // 'regions' maps to the admin1/ folder in R2 (internal naming)
  const r2Layer = layer === 'regions' ? 'admin1' : layer;
  const r2Key = layer === 'countries' || layer === 'regions'
    ? `${r2Layer}/${fileDetail}.topojson`
    : `physical/${layer}/${fileDetail}.topojson`;

  const obj = await env.GEO_BUCKET.get(r2Key);
  if (!obj) return error(`No data for layer='${layer}' detail='${detail}'`, 404);

  const topo = await obj.json();
  const objectKey = Object.keys(topo.objects)[0];

  // Filter features by continent or country
  filterFeatures(topo, objectKey, { filter, layer });

  // Merge properties for countries layer only (regions embed name in base topojson)
  if (layer === 'countries') {
    const props = await getProps(env.GEO_BUCKET);
    mergeProperties(topo, objectKey, props, properties);
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

    if (url.pathname === '/') {
      return new Response('mapjson API — see https://mapjson.com', { headers: CORS });
    }

    return error('Not found', 404);
  },
};
