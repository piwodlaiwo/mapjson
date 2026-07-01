const VALID_LAYERS = new Set(['countries', 'regions', 'lakes', 'rivers', 'coastlines']);
const VALID_FILTERS = new Set(['world', 'europe', 'asia', 'africa', 'north-america', 'south-america', 'oceania', 'antarctica']);
const VALID_DETAIL = new Set(['low', 'medium', 'high', 'ultra']);
const VALID_FORMAT = new Set(['topojson', 'geojson']);

// ISO alpha-2: two uppercase letters
const ISO2_RE = /^[A-Z]{2}$/;

export function parseAndValidate(url) {
  const q = new URL(url).searchParams;

  const layer = q.get('layer') || 'countries';
  const filter = q.get('filter') || 'world';
  const detail = q.get('detail') || 'low';
  const format = q.get('format') || 'topojson';
  const propParam = q.get('properties');
  const properties = propParam ? propParam.split(',').map((s) => s.trim()).filter(Boolean) : [];

  const errors = [];

  if (!VALID_LAYERS.has(layer)) {
    errors.push(`layer must be one of: ${[...VALID_LAYERS].join(', ')}`);
  }
  if (!VALID_FILTERS.has(filter) && !ISO2_RE.test(filter)) {
    errors.push(`filter must be a continent slug (e.g. europe) or ISO alpha-2 country code (e.g. FR)`);
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
