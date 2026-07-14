/**
 * Aligns enclave borders across data sources.
 *
 * Problem: per-country high-res files (processed/countries/iso/*.topojson) come from
 * DIVA-GIS, while the global tiers come from Natural Earth. A host country served from
 * the global file carves its enclaves out as crude simplified holes (Italy's San Marino
 * hole is a 19-point ring up to ~2.3 km off DIVA's 902-point outline), so combining
 * filter=Italy with filter=San%20Marino client-side shows slivers along the border.
 *
 * Fix: for each host in ENCLAVES, build a per-country high-res file for the HOST too —
 * its geometry is the global high-tier geometry with every enclave hole ring replaced by
 * the enclave's own DIVA outer ring. The worker already prefers countries/iso/{ISO2}
 * for single-country high requests, so filter=IT&detail=high then matches
 * filter=SM/VA&detail=high exactly.
 *
 * Run after: npm run process && npm run process-iso   (writes processed/countries/iso/)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HIGH = path.join(ROOT, 'processed/countries/high.topojson');
const ISO_DIR = path.join(ROOT, 'processed/countries/iso');

// host ISO2 -> enclave ISO2s (fully surrounded, served from DIVA iso files)
const ENCLAVES = { IT: ['SM', 'VA'] };

const QUANT = 1e6; // quantization grid for the emitted host file (~1.3 m over Italy's extent)

// ── topojson decode ──────────────────────────────────────────────────────────
function decodeArcs(topo) {
  const t = topo.transform;
  return topo.arcs.map((arc) => {
    if (!t) return arc.map((p) => [p[0], p[1]]);
    let x = 0, y = 0;
    return arc.map((p) => {
      x += p[0]; y += p[1];
      return [x * t.scale[0] + t.translate[0], y * t.scale[1] + t.translate[1]];
    });
  });
}
function assembleRing(arcIdxs, arcs) {
  const out = [];
  for (const idx of arcIdxs) {
    const a = idx >= 0 ? arcs[idx] : arcs[~idx].slice().reverse();
    for (let i = out.length ? 1 : 0; i < a.length; i++) out.push(a[i]);
  }
  return out;
}
// geometry -> MultiPolygon coordinate array (absolute lng/lat)
function decodeGeometry(geom, arcs) {
  const polys = geom.type === 'Polygon' ? [geom.arcs] : geom.arcs;
  return polys.map((poly) => poly.map((ring) => assembleRing(ring, arcs)));
}

// ── topojson encode (single feature, one arc per ring, quantized + delta) ────
function encodeTopo(coords, props) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of coords) for (const ring of poly) for (const [x, y] of ring) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const kx = (x1 - x0) / (QUANT - 1) || 1, ky = (y1 - y0) / (QUANT - 1) || 1;
  const arcs = [];
  const geomArcs = coords.map((poly) => poly.map((ring) => {
    const q = ring.map(([x, y]) => [Math.round((x - x0) / kx), Math.round((y - y0) / ky)]);
    const clean = [q[0]];
    for (let i = 1; i < q.length; i++) {
      const p = clean[clean.length - 1];
      if (q[i][0] !== p[0] || q[i][1] !== p[1]) clean.push(q[i]);
    }
    // a ring must close on itself after quantization
    if (clean[0][0] !== clean[clean.length - 1][0] || clean[0][1] !== clean[clean.length - 1][1]) clean.push(clean[0]);
    const arc = [clean[0].slice()];
    for (let i = 1; i < clean.length; i++) arc.push([clean[i][0] - clean[i - 1][0], clean[i][1] - clean[i - 1][1]]);
    arcs.push(arc);
    return [arcs.length - 1];
  }));
  return {
    type: 'Topology',
    transform: { scale: [kx, ky], translate: [x0, y0] },
    objects: { geo: { type: 'GeometryCollection', geometries: [{ type: 'MultiPolygon', arcs: geomArcs, properties: props }] } },
    arcs,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────
function signedArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return a / 2;
}
function bboxOf(ring) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
}
function overlaps(a, b, pad) {
  return a[0] < b[2] + pad && a[2] > b[0] - pad && a[1] < b[3] + pad && a[3] > b[1] - pad;
}
function loadCountry(file, gid) {
  const topo = JSON.parse(fs.readFileSync(file, 'utf8'));
  const obj = topo.objects.geo || topo.objects[Object.keys(topo.objects)[0]];
  const geom = gid ? obj.geometries.find((g) => g.properties && g.properties.gid === gid) : obj.geometries[0];
  if (!geom) throw new Error(`gid ${gid} not found in ${file}`);
  return decodeGeometry(geom, decodeArcs(topo));
}
// largest polygon's outer ring — SM/VA are single polygons, but stay general
function outerRing(coords) {
  let best = null, bestA = -1;
  for (const poly of coords) {
    const a = Math.abs(signedArea(poly[0]));
    if (a > bestA) { bestA = a; best = poly[0]; }
  }
  return best;
}

// ── main ─────────────────────────────────────────────────────────────────────
for (const [host, enclaves] of Object.entries(ENCLAVES)) {
  console.log(`Patching ${host} enclave holes: ${enclaves.join(', ')}`);
  const hostCoords = loadCountry(HIGH, host);

  let replaced = 0;
  for (const enc of enclaves) {
    const encRing = outerRing(loadCountry(path.join(ISO_DIR, `${enc}.topojson`)));
    const encBox = bboxOf(encRing);
    for (const poly of hostCoords) {
      for (let r = 1; r < poly.length; r++) {           // rings after [0] are holes
        if (!overlaps(bboxOf(poly[r]), encBox, 0.05)) continue;
        const ring = encRing.slice();
        // a hole must wind opposite its outer ring
        if (Math.sign(signedArea(ring)) === Math.sign(signedArea(poly[0]))) ring.reverse();
        poly[r] = ring;
        replaced++;
        console.log(`  ${enc}: replaced ${host} hole with ${ring.length}-pt DIVA outline`);
      }
    }
  }
  if (replaced !== enclaves.length) {
    console.error(`  ✘ expected ${enclaves.length} hole replacements, made ${replaced} — aborting ${host}`);
    process.exitCode = 1;
    continue;
  }

  const out = path.join(ISO_DIR, `${host}.topojson`);
  fs.writeFileSync(out, JSON.stringify(encodeTopo(hostCoords, { gid: host, iso2: host })));
  console.log(`✓ ${path.relative(ROOT, out)}`);

  // verify: re-read what we wrote, measure hole↔enclave deviation
  for (const enc of enclaves) {
    const encRing = outerRing(loadCountry(path.join(ISO_DIR, `${enc}.topojson`)));
    const encBox = bboxOf(encRing);
    const check = loadCountry(out, host);
    let worst = 0, found = false;
    for (const poly of check) for (let r = 1; r < poly.length; r++) {
      if (!overlaps(bboxOf(poly[r]), encBox, 0.05)) continue;
      found = true;
      for (const p of poly[r]) {
        let best = Infinity;
        for (const q of encRing) { const d = Math.hypot(p[0] - q[0], p[1] - q[1]); if (d < best) best = d; }
        if (best > worst) worst = best;
      }
    }
    console.log(`  verify ${host}↔${enc}: ${found ? (worst * 111000).toFixed(1) + ' m worst deviation' : 'HOLE NOT FOUND'}`);
    if (!found || worst * 111000 > 10) process.exitCode = 1;
  }
}
