/**
 * Builds catalog JSON files — one per layer — used by the /v1/catalog API endpoint.
 *
 * Each catalog is a JSON array where every entry represents one feature and carries:
 *   gid        — the stable identifier (ISO alpha-2 for countries, ISO 3166-2 for regions,
 *                5-digit FIPS for US counties)
 *   name       — human-readable name
 *   layer      — which layer this feature belongs to
 *   parent_gid — gid of the parent feature (null for countries, country iso2 for regions,
 *                state ISO 3166-2 for districts)
 *   + external codes where available (iso3, isoNum, hasc, fips, etc.)
 *
 * The catalog lets clients discover all valid gids, traverse the hierarchy, and
 * translate between code systems without downloading geometry.
 *
 * Run after: npm run process && npm run build-props
 */

const fs   = require('fs');
const path = require('path');

const PROCESSED  = path.join(__dirname, '../processed');
const PROPS_FILE = path.join(PROCESSED, 'properties.json');
const OUT_DIR    = path.join(PROCESSED, 'catalog');

// Extract feature properties directly from topojson geometries — no library needed.
function readTopoProperties(file) {
  const topo = JSON.parse(fs.readFileSync(file, 'utf8'));
  const key  = Object.keys(topo.objects)[0];
  return (topo.objects[key].geometries || []).map((g) => g.properties || {});
}

// Lowest detail tier (low → medium → high) whose geometry actually contains each
// country. Small nations (e.g. Cabo Verde) are absent from Natural Earth 110m and only
// appear at medium/high; per-country hi-res files under countries/iso/ are served at
// detail=high. Exposed as `minDetail` so clients know which detail to request instead of
// getting a silently-empty response.
const DETAIL_TIERS = ['low', 'medium', 'high'];

function makeMinDetailResolver() {
  const tierSets = {};
  for (const tier of DETAIL_TIERS) {
    const file = path.join(PROCESSED, `countries/${tier}.topojson`);
    if (!fs.existsSync(file)) { tierSets[tier] = null; continue; }
    tierSets[tier] = new Set(readTopoProperties(file).map((p) => p.iso2).filter(Boolean));
  }
  const isoDir = path.join(PROCESSED, 'countries/iso');
  const isoFiles = fs.existsSync(isoDir)
    ? new Set(fs.readdirSync(isoDir).filter((f) => f.endsWith('.topojson')).map((f) => f.replace('.topojson', '').toUpperCase()))
    : new Set();

  return (iso2) => {
    if (!iso2) return null;
    if (tierSets.low?.has(iso2)) return 'low';
    if (tierSets.medium?.has(iso2)) return 'medium';
    if (tierSets.high?.has(iso2) || isoFiles.has(iso2)) return 'high';
    return null;   // no geometry at any detail (properties-only entry)
  };
}

function buildCountries(props) {
  const minDetailOf = makeMinDetailResolver();
  const entries = [];
  for (const [gid, p] of Object.entries(props)) {
    entries.push({
      gid,
      name:       p.name       || null,
      layer:      'countries',
      parent_gid: null,
      iso2:       p.iso2       || null,
      iso3:       p.iso3       || null,
      isoNum:     p.isoNum     || null,
      continent:  p.continent  || null,
      subregion:  p.subregion  || null,
      minDetail:  minDetailOf(p.iso2 || gid),
    });
  }
  entries.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return entries;
}

function buildRegions() {
  // Use the high-resolution admin1 topojson — it has the most complete gid coverage.
  // Deduplicate by gid (same region appears at low/medium/high with same gid).
  const file = path.join(PROCESSED, 'admin1/high.topojson');
  if (!fs.existsSync(file)) {
    console.warn('  skipping regions catalog — processed/admin1/high.topojson not found');
    return [];
  }

  const propsArr = readTopoProperties(file);
  const seen = new Map();

  for (const p of propsArr) {
    if (!p.gid || seen.has(p.gid)) continue;

    // Detect gid_source: ISO 3166-2 uses hyphens (US-CA); HASC uses dots (US.CA)
    const gidSource = p.gid.includes('.') ? 'hasc' : 'iso3166-2';

    seen.set(p.gid, {
      gid:        p.gid,
      name:       p.name       || null,
      layer:      'regions',
      parent_gid: p.parent_gid || p.iso2 || null,
      iso2:       p.iso2       || null,
      gid_source: gidSource,
    });
  }

  return [...seen.values()].sort((a, b) => (a.gid || '').localeCompare(b.gid || ''));
}

function buildDistricts() {
  const file = path.join(PROCESSED, 'districts/high.topojson');
  if (!fs.existsSync(file)) {
    console.warn('  skipping districts catalog — processed/districts/high.topojson not found');
    return [];
  }

  const propsArr = readTopoProperties(file);
  const entries  = [];

  for (const p of propsArr) {
    if (!p.gid) continue;
    entries.push({
      gid:        p.gid,
      name:       p.name       || null,
      layer:      'districts',
      parent_gid: p.parent_gid || null,
      iso2:       p.iso2       || null,
      gid_source: 'fips',
    });
  }

  entries.sort((a, b) => (a.gid || '').localeCompare(b.gid || ''));
  return entries;
}

function buildPostal() {
  const dir = path.join(PROCESSED, 'postal');
  if (!fs.existsSync(dir)) {
    console.warn('  skipping postal catalog — processed/postal/ not found');
    return [];
  }

  const entries = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.topojson'))) {
    for (const p of readTopoProperties(path.join(dir, file))) {
      if (!p.gid) continue;
      entries.push({
        gid:        p.gid,
        name:       p.gid,          // ZCTAs have no names — the code is the name
        layer:      'postal',
        parent_gid: p.parent_gid || null,
        iso2:       p.iso2       || null,
        gid_source: 'zcta',
      });
    }
  }

  entries.sort((a, b) => (a.gid || '').localeCompare(b.gid || ''));
  return entries;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (!fs.existsSync(PROPS_FILE)) {
    console.error('properties.json not found — run npm run build-props first');
    process.exit(1);
  }
  const props = JSON.parse(fs.readFileSync(PROPS_FILE, 'utf8'));

  console.log('Building countries catalog...');
  const countries = buildCountries(props);
  fs.writeFileSync(path.join(OUT_DIR, 'countries.json'), JSON.stringify(countries));
  console.log(`  ✓ ${countries.length} countries/territories`);

  console.log('Building regions catalog...');
  const regions = buildRegions();
  fs.writeFileSync(path.join(OUT_DIR, 'regions.json'), JSON.stringify(regions));
  console.log(`  ✓ ${regions.length} regions`);

  console.log('Building districts catalog...');
  const districts = buildDistricts();
  fs.writeFileSync(path.join(OUT_DIR, 'districts.json'), JSON.stringify(districts));
  console.log(`  ✓ ${districts.length} districts`);

  console.log('Building postal catalog...');
  const postal = buildPostal();
  fs.writeFileSync(path.join(OUT_DIR, 'postal.json'), JSON.stringify(postal));
  console.log(`  ✓ ${postal.length} ZCTAs`);

  console.log('Done. Run: npm run upload');
}

main().catch((err) => { console.error(err); process.exit(1); });
