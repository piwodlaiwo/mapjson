// All available property keys and how they map to entries in properties.json
const ALL_PROP_KEYS = ['name', 'nameOfficial', 'iso2', 'iso3', 'isoNum', 'continent', 'subregion', 'capital', 'capitalLat', 'capitalLng'];

/**
 * Merges attributes from the properties lookup onto each topojson feature.
 * Replaces the minimal base properties (gid, disputed, cont) with the
 * requested set of human-readable attributes.
 *
 * @param {object} topo - parsed topojson (mutated in place)
 * @param {string} objectKey
 * @param {object} lookup - the properties.json object keyed by gid
 * @param {string[]} requestedProps - empty array (default) = no properties; named keys = those only
 */
export function mergeProperties(topo, objectKey, lookup, requestedProps) {
  const wantedKeys = requestedProps && requestedProps.length > 0
    ? ALL_PROP_KEYS.filter((k) => requestedProps.includes(k))
    : [];

  const obj = topo.objects[objectKey];
  if (!obj || !obj.geometries) return;

  for (const g of obj.geometries) {
    const p = g.properties || {};
    const isDisputed = p.disputed === true;
    const entry = lookup[p.gid] || null;

    if (wantedKeys.length === 0) {
      g.properties = isDisputed ? { disputed: true } : {};
      continue;
    }

    const merged = {};
    for (const k of wantedKeys) {
      merged[k] = entry ? (entry[k] ?? null) : null;
    }
    if (isDisputed) merged.disputed = true;

    g.properties = merged;
  }
}
