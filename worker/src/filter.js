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
      return p.iso2 === filter.toUpperCase();
    }

    return true;
  });
}
