// Maps API filter continent slugs → Natural Earth CONTINENT strings
const CONTINENT_MAP = {
  europe: 'Europe',
  asia: 'Asia',
  africa: 'Africa',
  'north-america': 'North America',
  'south-america': 'South America',
  oceania: 'Oceania',
  antarctica: 'Antarctica',
};

export function filterFeatures(topo, objectKey, params) {
  const { filter, layer } = params;
  const obj = topo.objects[objectKey];
  if (!obj || !obj.geometries) return;

  obj.geometries = obj.geometries.filter((g) => {
    const p = g.properties || {};

    if (layer === 'countries' || layer === 'regions') {
      if (filter === 'world') return true;
      const continentName = CONTINENT_MAP[filter];
      if (continentName) return p.cont === continentName;
      return p.iso2 === filter.toUpperCase();
    }

    if (layer === 'districts') {
      if (filter === 'world') return true;
      const f = filter.toUpperCase();
      // ISO 3166-2 region code (e.g. US-MA) → match by parent_gid
      // ISO alpha-2 country code (e.g. US) → match by iso2
      return f.includes('-') ? p.parent_gid === f : p.iso2 === f;
    }

    return true;
  });
}
