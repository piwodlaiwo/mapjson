/**
 * Processes per-country high-res TopoJSON files from piwodlaiwo/TopoJSON-Data (DIVA-GIS source).
 * Strips properties to match the format the Worker expects, then writes to processed/countries/iso/
 * and processed/admin1/iso/. The upload step picks these up automatically.
 *
 * Run after: npm run download-iso
 */

const fs   = require('fs');
const path = require('path');

const ROOT         = path.join(__dirname, '..');
const DATA_DIR     = path.join(ROOT, 'data/iso');
const OUT_COUNTRIES = path.join(ROOT, 'processed/countries/iso');
const OUT_ADMIN1    = path.join(ROOT, 'processed/admin1/iso');

// All ISO3 codes with their own adm0 file in the repo
const ISO3_LIST = [
  // European microstates + small territories
  'VAT','MCO','SMR','LIE','AND','MLT','GIB','IMN','JEY','GGY',
  // Middle East / Asia
  'SGP','BHR','MDV',
  // Caribbean independent states
  'BRB','KNA','ATG','DMA','LCA','VCT','GRD',
  // French territories
  'MTQ','GLP','ABW','MYT','REU','SPM',
  // British Caribbean territories
  'CYM','VGB','AIA','TCA','MSR','BMU',
  // US territories
  'VIR','GUM','ASM','MNP',
  // Atlantic / Indian Ocean
  'CPV','STP','COM','SYC',
  // Pacific
  'NRU','TUV','PLW','MHL','FSM','KIR','TON','WSM','NIU','COK',
  'TKL','WLF','PYF',
  // Australian territories
  'CXR','CCK','NFK',
];

// Netherlands Antilles dissolved in 2010 — split adm1 features into three successor entities
const ANT_SUCCESSORS = [
  { iso2: 'BQ', iso3: 'BES', isoNum: 535, names: new Set(['Bonaire', 'Saba', 'Sint Eustatius']) },
  { iso2: 'CW', iso3: 'CUW', isoNum: 531, names: new Set(['Curaçao']) },
  { iso2: 'SX', iso3: 'SXM', isoNum: 534, names: new Set(['Sint Maarten']) },
];

function readTopo(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Deep clone via JSON round-trip — these are small files so this is fine
function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function normalizeKey(topo) {
  const key = Object.keys(topo.objects)[0];
  if (key !== 'geo') {
    topo.objects.geo = topo.objects[key];
    delete topo.objects[key];
  }
}

function write(outPath, topo) {
  fs.writeFileSync(outPath, JSON.stringify(topo));
}

function processCountry(iso3) {
  const adm0Path = path.join(DATA_DIR, iso3, 'adm0.topo.json');
  const topo = readTopo(adm0Path);
  if (!topo) return null;

  const key   = Object.keys(topo.objects)[0];
  const geoms = topo.objects[key].geometries;
  if (!geoms?.length) return null;

  const p      = geoms[0].properties || {};
  const iso2   = p.ISO2   || null;
  const isoNum = p.ISON   || 0;
  const gid    = isoNum > 0 ? String(isoNum) : `x-${iso3}`;

  for (const g of geoms) {
    g.properties = { gid, iso2 };
  }
  normalizeKey(topo);

  return { topo, iso2 };
}

function processRegions(iso3, iso2) {
  const adm1Path = path.join(DATA_DIR, iso3, 'adm1.topo.json');
  const topo = readTopo(adm1Path);
  if (!topo) return null;

  const key   = Object.keys(topo.objects)[0];
  const geoms = topo.objects[key].geometries;
  if (!geoms?.length) return null;

  for (const g of geoms) {
    g.properties = { name: g.properties?.NAME_1 || null };
  }
  normalizeKey(topo);

  return topo;
}

function processANT() {
  const antPath = path.join(DATA_DIR, 'ANT', 'adm1.topo.json');
  const base = readTopo(antPath);
  if (!base) {
    console.warn('  ⚠ ANT adm1 not found — skipping BES/CUW/SXM');
    return;
  }

  const key      = Object.keys(base.objects)[0];
  const allGeoms = base.objects[key].geometries;

  for (const { iso2, iso3, isoNum, names } of ANT_SUCCESSORS) {
    const matching = allGeoms.filter(g => names.has(g.properties?.NAME_1));
    if (!matching.length) {
      console.warn(`  ⚠ no ANT features matched for ${iso3}`);
      continue;
    }

    // adm0 — country outline from the island feature(s)
    const adm0 = clone(base);
    adm0.objects.geo = {
      type: 'GeometryCollection',
      geometries: matching.map(g => ({ ...g, properties: { gid: String(isoNum), iso2 } })),
    };
    delete adm0.objects[key];
    write(path.join(OUT_COUNTRIES, `${iso2}.topojson`), adm0);
    console.log(`  ✓ countries/iso/${iso2}.topojson  (${iso3})`);

    // adm1 — only meaningful for BES (3 distinct islands); CUW/SXM are single islands
    if (names.size > 1) {
      const adm1 = clone(base);
      adm1.objects.geo = {
        type: 'GeometryCollection',
        geometries: matching.map(g => ({ ...g, properties: { name: g.properties?.NAME_1 || null } })),
      };
      delete adm1.objects[key];
      write(path.join(OUT_ADMIN1, `${iso2}.topojson`), adm1);
      console.log(`  ✓ admin1/iso/${iso2}.topojson  (${iso3})`);
    }
  }
}

function main() {
  fs.mkdirSync(OUT_COUNTRIES, { recursive: true });
  fs.mkdirSync(OUT_ADMIN1,    { recursive: true });

  let ok = 0, skipped = 0;

  for (const iso3 of ISO3_LIST) {
    const country = processCountry(iso3);
    if (!country) {
      console.warn(`  ⚠ skipping ${iso3} (no adm0 file)`);
      skipped++;
      continue;
    }

    const { topo, iso2 } = country;
    write(path.join(OUT_COUNTRIES, `${iso2}.topojson`), topo);
    console.log(`  ✓ countries/iso/${iso2}.topojson`);

    const regions = processRegions(iso3, iso2);
    if (regions) {
      write(path.join(OUT_ADMIN1, `${iso2}.topojson`), regions);
      console.log(`  ✓ admin1/iso/${iso2}.topojson`);
    }

    ok++;
  }

  processANT();

  console.log(`\nDone. ${ok} countries processed, ${skipped} skipped.`);
  console.log('Run: npm run upload');
}

main();
