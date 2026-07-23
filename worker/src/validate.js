const VALID_LAYERS  = new Set(['countries', 'regions', 'districts', 'postal', 'lakes', 'rivers', 'coastlines']);
const VALID_FILTERS = new Set(['world', 'europe', 'asia', 'africa', 'north-america', 'south-america', 'oceania', 'antarctica']);
const VALID_DETAIL  = new Set(['auto', 'low', 'medium', 'high', 'ultra']);
const VALID_FORMAT  = new Set(['topojson', 'geojson']);
// The only query params /v1/geo understands. Anything else is a mistake we
// reject rather than silently ignore — otherwise a typo like ?country=AW drops
// the intended filter and quietly falls back to filter=world (the whole planet).
const VALID_PARAMS  = new Set(['layer', 'filter', 'detail', 'format', 'properties']);
// Common wrong param names → the one the user probably meant.
const PARAM_HINTS = {
  country: 'filter', countries: 'filter', region: 'filter', continent: 'filter',
  iso2: 'filter', iso: 'filter', code: 'filter', name: 'filter', q: 'filter',
  resolution: 'detail', res: 'detail', quality: 'detail',
  props: 'properties', property: 'properties', fields: 'properties', type: 'layer',
};

// ISO alpha-2: two uppercase letters
const ISO2_RE = /^[A-Z]{2}$/;
// ISO 3166-2 region code: two uppercase letters, hyphen, one or more alphanumeric (e.g. US-MA, DE-BY)
const ISO3166_2_RE = /^[A-Z]{2}-[A-Z0-9]+$/;
// Country name: any Unicode letter (so native/accented names like "Türkiye", "Côte
// d'Ivoire" pass), plus combining marks, spaces, hyphens, apostrophes, dots, parens.
// Resolved to iso2 at runtime (exact match, then the ontology resolver).
const NAME_RE = /^\p{L}[\p{L}\p{M}\s'.()-]*$/u;

export function parseAndValidate(url) {
  const q = new URL(url).searchParams;

  const layer  = q.get('layer')  || 'countries';
  const filter = q.get('filter') || 'world';
  const detail = q.get('detail') || 'auto';   // auto = server picks the right tier for the filter (see resolveAutoDetail)
  const format = q.get('format') || 'topojson';
  const propParam  = q.get('properties');
  const properties = propParam ? propParam.split(',').map((s) => s.trim()).filter(Boolean) : [];

  const errors = [];

  // Reject unknown params up front so a typo can't silently degrade the request.
  for (const key of q.keys()) {
    if (VALID_PARAMS.has(key)) continue;
    const hint = PARAM_HINTS[key.toLowerCase()];
    errors.push(
      `unknown parameter '${key}'${hint ? ` — did you mean '${hint}'?` : ''} — valid parameters are: ${[...VALID_PARAMS].join(', ')}`
    );
  }

  if (!VALID_LAYERS.has(layer)) {
    errors.push(`layer must be one of: ${[...VALID_LAYERS].join(', ')}`);
  }
  if (!VALID_FILTERS.has(filter) && !ISO2_RE.test(filter) && !ISO3166_2_RE.test(filter) && !NAME_RE.test(filter)) {
    errors.push(`filter must be a continent slug (e.g. europe), ISO alpha-2 code (e.g. FR), ISO 3166-2 region code (e.g. US-MA), or country name (e.g. France)`);
  }
  if (layer === 'regions' && filter === 'world') {
    errors.push(`regions layer requires a filter — use a continent slug (e.g. filter=europe) or country code (e.g. filter=US)`);
  }
  if (layer === 'districts' && (filter === 'world' || VALID_FILTERS.has(filter))) {
    errors.push(`districts layer requires a country or region filter — use an ISO alpha-2 code (e.g. filter=US) or ISO 3166-2 region code (e.g. filter=US-MA)`);
  }
  // postal is served from per-state files (~33k ZCTAs nationally is too large
  // for a single response), so a state-level region code is mandatory
  if (layer === 'postal' && !ISO3166_2_RE.test(filter)) {
    errors.push(`postal layer requires a state filter — use an ISO 3166-2 region code (e.g. filter=US-MA)`);
  }
  if (!VALID_DETAIL.has(detail)) {
    errors.push(`detail must be one of: auto, low, medium, high, ultra`);
  }
  if (!VALID_FORMAT.has(format)) {
    errors.push(`format must be topojson or geojson`);
  }

  if (errors.length) return { ok: false, errors };

  return { ok: true, params: { layer, filter, detail, format, properties } };
}
