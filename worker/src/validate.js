const VALID_LAYERS  = new Set(['countries', 'regions', 'districts', 'lakes', 'rivers', 'coastlines']);
const VALID_FILTERS = new Set(['world', 'europe', 'asia', 'africa', 'north-america', 'south-america', 'oceania', 'antarctica']);
const VALID_DETAIL  = new Set(['low', 'medium', 'high', 'ultra']);
const VALID_FORMAT  = new Set(['topojson', 'geojson']);

// ISO alpha-2: two uppercase letters
const ISO2_RE = /^[A-Z]{2}$/;
// ISO 3166-2 region code: two uppercase letters, hyphen, one or more alphanumeric (e.g. US-MA, DE-BY)
const ISO3166_2_RE = /^[A-Z]{2}-[A-Z0-9]+$/;
// Country name: letters, spaces, hyphens, apostrophes — resolved to iso2 at runtime
const NAME_RE = /^[A-Za-z][A-Za-z\s'.()-]*$/;

export function parseAndValidate(url) {
  const q = new URL(url).searchParams;

  const layer  = q.get('layer')  || 'countries';
  const filter = q.get('filter') || 'world';
  const detail = q.get('detail') || 'low';
  const format = q.get('format') || 'topojson';
  const propParam  = q.get('properties');
  const properties = propParam ? propParam.split(',').map((s) => s.trim()).filter(Boolean) : [];

  const errors = [];

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
  if (!VALID_DETAIL.has(detail)) {
    errors.push(`detail must be one of: low, medium, high, ultra`);
  }
  if (!VALID_FORMAT.has(format)) {
    errors.push(`format must be topojson or geojson`);
  }

  if (errors.length) return { ok: false, errors };

  return { ok: true, params: { layer, filter, detail, format, properties } };
}
