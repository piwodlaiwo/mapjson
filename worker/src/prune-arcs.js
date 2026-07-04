/**
 * Removes unreferenced arcs from a filtered topojson topology.
 *
 * When features are filtered out of a global topojson, the arcs array still
 * contains every arc from the original file. This walks the remaining geometries,
 * collects which arcs are actually referenced, compacts the arcs array to only
 * those entries, and remaps all arc indices in the geometries.
 *
 * TopoJSON uses bitwise NOT for reversed arcs: a negative index n means arc ~n
 * traversed in reverse. Both directions decode to the same underlying arc index.
 */
export function pruneArcs(topo, objectKey) {
  const obj = topo.objects[objectKey];
  if (!obj || !obj.geometries || !topo.arcs || topo.arcs.length === 0) return;

  const used = new Set();

  function collect(geom) {
    if (!geom) return;
    const t = geom.type;
    if (t === 'Polygon' || t === 'MultiLineString') {
      for (const ring of geom.arcs)
        for (const ref of ring) used.add(ref < 0 ? ~ref : ref);
    } else if (t === 'MultiPolygon') {
      for (const poly of geom.arcs)
        for (const ring of poly)
          for (const ref of ring) used.add(ref < 0 ? ~ref : ref);
    } else if (t === 'LineString') {
      for (const ref of geom.arcs) used.add(ref < 0 ? ~ref : ref);
    } else if (t === 'GeometryCollection') {
      for (const g of geom.geometries) collect(g);
    }
  }

  for (const g of obj.geometries) collect(g);

  // Nothing to prune — all arcs are in use
  if (used.size === topo.arcs.length) return;

  const sorted = [...used].sort((a, b) => a - b);
  const remap  = new Map(sorted.map((oldIdx, newIdx) => [oldIdx, newIdx]));

  topo.arcs = sorted.map(i => topo.arcs[i]);

  const reindex = (ref) => ref < 0 ? ~remap.get(~ref) : remap.get(ref);

  function patch(geom) {
    if (!geom) return;
    const t = geom.type;
    if (t === 'Polygon' || t === 'MultiLineString') {
      geom.arcs = geom.arcs.map(ring => ring.map(reindex));
    } else if (t === 'MultiPolygon') {
      geom.arcs = geom.arcs.map(poly => poly.map(ring => ring.map(reindex)));
    } else if (t === 'LineString') {
      geom.arcs = geom.arcs.map(reindex);
    } else if (t === 'GeometryCollection') {
      for (const g of geom.geometries) patch(g);
    }
  }

  for (const g of obj.geometries) patch(g);

  // bbox was computed for the original full topology — remove it to avoid stale values
  delete topo.bbox;
}
