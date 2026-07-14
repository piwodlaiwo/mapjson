/**
 * Builds properties.json — the attribute lookup table used by the Worker to
 * merge country metadata (names, ISO codes, capitals, etc.) onto topojson
 * features at request time.
 *
 * Also builds:
 *   - processed/points/city.json — GeoJSON of the world's major cities (pop ≥ 1M)
 *     plus every national capital. Capitals carry capital:true; each point is
 *     tagged with its country (countryIso2), continent, and admin1 region (ISO
 *     3166-2, via point-in-polygon against the admin1 shapefile). Served at /v1/points.
 *
 * Sources:
 *   - data/10m/ne_10m_admin_0_countries.{shp,dbf}
 *   - data/10m/ne_10m_populated_places.{shp,dbf}
 *   - data/10m/ne_10m_admin_1_states_provinces.{shp,dbf}  (region tagging)
 */

const fs = require('fs');
const shapefile = require('shapefile');

const CAPITAL_CLASS = 'Admin-0 capital';
const CITY_POP_THRESHOLD = 1_000_000;

// The 44 landlocked sovereign states, by ISO alpha-2 (== gid here). Countries with
// no coastline carry a `landlocked: true` property (mirrors how disputed features
// carry `disputed: true`); all others omit the key entirely.
const LANDLOCKED = new Set([
  'AF', 'AD', 'AM', 'AT', 'AZ', 'BY', 'BT', 'BO', 'BW', 'BF', 'BI', 'CF', 'TD',
  'CZ', 'ET', 'HU', 'KZ', 'KG', 'LA', 'LS', 'LI', 'LU', 'MW', 'ML', 'MD', 'MN',
  'NP', 'NE', 'MK', 'PY', 'RW', 'SM', 'RS', 'SK', 'SS', 'SZ', 'CH', 'TJ', 'TM',
  'UG', 'UZ', 'VA', 'ZM', 'ZW',
]);

// mledoze/countries (public domain) — currencies, languages, idd, demonyms.
// Joined onto props by ISO alpha-2 (cca2 there == iso2 here). Run: npm run download-mledoze
const MLEDOZE_FILE = 'data/mledoze/countries.json';

function loadMledoze() {
  if (!fs.existsSync(MLEDOZE_FILE)) {
    console.warn(`  ⚠ ${MLEDOZE_FILE} not found — currencies/languages/idd/demonym will be null. Run: npm run download-mledoze`);
    return {};
  }
  const list = JSON.parse(fs.readFileSync(MLEDOZE_FILE, 'utf8'));
  const byIso2 = {};
  for (const c of list) if (c.cca2) byIso2[c.cca2] = c;
  return byIso2;
}

// Shapes chosen to stay flat/simple like the rest of properties.json, while keeping
// enough fidelity for real use (a country can have 2+ currencies or languages).
function mledozeFields(entry) {
  if (!entry) return { currencies: null, languages: null, idd: null, demonym: null };

  const currencies = entry.currencies
    ? Object.entries(entry.currencies).map(([code, c]) => ({ code, name: c.name || null, symbol: c.symbol || null }))
    : null;

  const languages = entry.languages
    ? Object.entries(entry.languages).map(([code, name]) => ({ code, name }))
    : null;

  const idd = entry.idd && entry.idd.root
    ? { root: entry.idd.root, suffixes: entry.idd.suffixes || [] }
    : null;

  // English demonym only — f/m forms are identical in English for every entry in the
  // source dataset, so this stays a flat string like the rest of properties.json rather
  // than a gendered/multi-language object.
  const demonym = entry.demonyms?.eng?.m || entry.demonyms?.eng?.f || null;

  return { currencies, languages, idd, demonym };
}

// .dbf fixed-width char fields are padded with NUL () bytes
function clean(val) {
  if (typeof val !== 'string') return val;
  return val.replace(/\u0000/g, '').trim() || null;
}

async function readDbf(path) {
  const source = await shapefile.openDbf(path, { encoding: 'utf-8' });
  const records = [];
  let result;
  while (!(result = await source.read()).done) {
    // Clean all string fields in each record
    const raw = result.value;
    const cleaned = {};
    for (const k of Object.keys(raw)) {
      cleaned[k] = typeof raw[k] === 'string' ? clean(raw[k]) : raw[k];
    }
    records.push(cleaned);
  }
  return records;
}

async function readShapefile(path) {
  const source = await shapefile.open(path, undefined, { encoding: 'utf-8' });
  const features = [];
  let result;
  while (!(result = await source.read()).done) {
    features.push(result.value);
  }
  return features;
}

const ISO_PATCHES = {
  FRA: { n3: 250, a2: 'FR' },
  NOR: { n3: 578, a2: 'NO' },
  KOS: { n3: 383, a2: 'XK' }, // Kosovo — EU-assigned informal code, widely used
  TWN: { n3: 158, a2: 'TW', a3: 'TWN' }, // Natural Earth carries China's POV ('CN-TW')
  // Territories Natural Earth ships without ISO codes — user-assigned X-codes.
  // Their features are flagged disputed=true in process.js.
  // Keep in sync with ISO2_OVERRIDES in process.js.
  ESB: { n3: null, a2: 'XD', a3: 'XDX' }, // Dhekelia
  SOL: { n3: null, a2: 'XS', a3: 'XSX' }, // Somaliland
  BRI: { n3: null, a2: 'XB', a3: 'XBX' }, // Brazilian Island
  CYN: { n3: null, a2: 'XC', a3: 'XCX' }, // Northern Cyprus
  CNM: { n3: null, a2: 'XZ', a3: 'XZX' }, // Cyprus U.N. Buffer Zone
  KAS: { n3: null, a2: 'XG', a3: 'XGX' }, // Siachen Glacier
  WSB: { n3: null, a2: 'XA', a3: 'XAX' }, // Akrotiri
  SPI: { n3: null, a2: 'XF', a3: 'XFX' }, // Southern Patagonian Ice Field
  BRT: { n3: null, a2: 'XT', a3: 'XTX' }, // Bir Tawil
  CLP: { n3: null, a2: 'XL', a3: 'XLX' }, // Clipperton Island
  CSI: { n3: null, a2: 'XO', a3: 'XOX' }, // Coral Sea Islands
  PGA: { n3: null, a2: 'XP', a3: 'XPX' }, // Spratly Islands
  ATC: { n3: null, a2: 'XH', a3: 'XHX' }, // Ashmore and Cartier Islands
  BJN: { n3: null, a2: 'XN', a3: 'XNX' }, // Bajo Nuevo Bank
  SER: { n3: null, a2: 'XE', a3: 'XEX' }, // Serranilla Bank
  SCR: { n3: null, a2: 'XR', a3: 'XRX' }, // Scarborough Reef
};

// Natural Earth carries these as admin_0_countries rows, but none of them has any
// boundary geometry anywhere in the pipeline: KAB/USG are TYPE=Lease, which
// process.js excludes from boundary generation entirely; IOA's own record
// "splits into CX + CC with no parent feature" (see process.js). A properties/gid
// entry with nothing to attach to is just dead weight in the API — skip them.
const NO_GEOMETRY = new Set(['KAB', 'USG', 'IOA']); // Baikonur, USNB Guantanamo Bay, Indian Ocean Territories

// Properties for territories split from their parent in process.js via admin_0_map_units.
// Keyed by ISO alpha-2, matching the gid scheme used in process.js.
const SPLIT_TERRITORY_PROPS = {
  'GF': { name: 'French Guiana',          nameOfficial: 'Guyane',                   iso2: 'GF', iso3: 'GUF', isoNum: '254', continent: 'South America',  subregion: 'South America' },
  'GP': { name: 'Guadeloupe',             nameOfficial: 'Guadeloupe',               iso2: 'GP', iso3: 'GLP', isoNum: '312', continent: 'North America',  subregion: 'Caribbean' },
  'MQ': { name: 'Martinique',             nameOfficial: 'Martinique',               iso2: 'MQ', iso3: 'MTQ', isoNum: '474', continent: 'North America',  subregion: 'Caribbean' },
  'RE': { name: 'Réunion',               nameOfficial: 'La Réunion',              iso2: 'RE', iso3: 'REU', isoNum: '638', continent: 'Africa',          subregion: 'Eastern Africa' },
  'YT': { name: 'Mayotte',               nameOfficial: 'Mayotte',                  iso2: 'YT', iso3: 'MYT', isoNum: '175', continent: 'Africa',          subregion: 'Eastern Africa' },
  'SJ': { name: 'Svalbard and Jan Mayen', nameOfficial: 'Svalbard og Jan Mayen',    iso2: 'SJ', iso3: 'SJM', isoNum: '744', continent: 'Europe',          subregion: 'Northern Europe' },
  'BQ': { name: 'Bonaire, Sint Eustatius and Saba', nameOfficial: 'Bonaire, Sint Eustatius, and Saba', iso2: 'BQ', iso3: 'BES', isoNum: '535', continent: 'North America', subregion: 'Caribbean' },
  'TK': { name: 'Tokelau',               nameOfficial: 'Tokelau',                   iso2: 'TK', iso3: 'TKL', isoNum: '772', continent: 'Oceania',          subregion: 'Polynesia' },
  'CX': { name: 'Christmas Island',      nameOfficial: 'Territory of Christmas Island', iso2: 'CX', iso3: 'CXR', isoNum: '162', continent: 'Asia',        subregion: 'South-Eastern Asia' },
  'CC': { name: 'Cocos Islands',         nameOfficial: 'Territory of Cocos (Keeling) Islands', iso2: 'CC', iso3: 'CCK', isoNum: '166', continent: 'Asia', subregion: 'South-Eastern Asia' },
};

const NAME_PATCHES = {
  USA: 'United States',
  COD: 'DR Congo',
  FLK: 'Falkland Islands',
  VAT: 'Vatican City',
  FRO: 'Faroe Islands',
  SWZ: 'Eswatini',
  SGS: 'South Georgia and South Sandwich Islands',
  TUR: 'Türkiye',
  CIV: 'Ivory Coast',
  // Natural Earth's raw NAME is truncated/abbreviated for these; NAME_LONG isn't
  // populated for all of them, so the general fallback below doesn't catch them.
  HMD: 'Heard Island and McDonald Islands',
  BLM: 'Saint-Barthélemy',
  MAF: 'Saint-Martin',
  ATG: 'Antigua and Barbuda',
  BIH: 'Bosnia and Herzegovina',
};

function gid(r) {
  const patch = ISO_PATCHES[r.ADM0_A3];
  if (patch) return patch.a2;
  const a2 = r.ISO_A2 && r.ISO_A2 !== '-99' ? r.ISO_A2 : null;
  return a2 || `x-${r.ADM0_A3}`;
}

function nullIfMissing(val) {
  return val && val !== '-99' && val !== '-1' ? val : null;
}

// Spherical polygon area in km² — trapezoidal formula on a sphere, no external deps.
// Outer ring adds area; inner rings (holes) subtract.
function ringAreaKm2(ring) {
  const RAD = Math.PI / 180;
  const R = 6371; // mean Earth radius km
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [lng1, lat1] = ring[i];
    const [lng2, lat2] = ring[i + 1];
    a += (lng2 - lng1) * RAD * (2 + Math.sin(lat1 * RAD) + Math.sin(lat2 * RAD));
  }
  return Math.abs(a) * R * R / 2;
}

function featureAreaKm2(geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let area = 0;
  for (const poly of polys) {
    area += ringAreaKm2(poly[0]);
    for (let i = 1; i < poly.length; i++) area -= ringAreaKm2(poly[i]);
  }
  return Math.round(area);
}

// Well-known areas (km²) for territories split from their parent in process.js via
// admin_0_map_units — these don't appear as separate records in admin_0_countries.shp.
const SPLIT_TERRITORY_AREAS = {
  GF: 83534,   // French Guiana
  GP: 1628,    // Guadeloupe
  MQ: 1128,    // Martinique
  RE: 2512,    // Réunion
  YT: 374,     // Mayotte
  SJ: 61022,   // Svalbard and Jan Mayen
  BQ: 322,     // Bonaire, Sint Eustatius and Saba
  TK: 12,      // Tokelau
  CX: 135,     // Christmas Island
  CC: 14,      // Cocos (Keeling) Islands
};

// ── Point-in-polygon (ray casting): stamps each city with the admin1 region that
// contains it, so `region` uses the exact gid scheme of the regions/districts
// layers (a build-time spatial join, no external deps). ──
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function pointInPolygon(x, y, polygon) { // polygon = [outerRing, ...holeRings]
  if (!pointInRing(x, y, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i++) if (pointInRing(x, y, polygon[i])) return false;
  return true;
}

function geomContains(x, y, geometry) {
  if (geometry.type === 'Polygon') return pointInPolygon(x, y, geometry.coordinates);
  if (geometry.type === 'MultiPolygon') {
    for (const poly of geometry.coordinates) if (pointInPolygon(x, y, poly)) return true;
  }
  return false;
}

function bboxOf(geometry) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const poly of polys) for (const pt of poly[0]) {
    if (pt[0] < minX) minX = pt[0];
    if (pt[0] > maxX) maxX = pt[0];
    if (pt[1] < minY) minY = pt[1];
    if (pt[1] > maxY) maxY = pt[1];
  }
  return [minX, minY, maxX, maxY];
}

// admin1 polygons keyed by region gid — ISO 3166-2 where Natural Earth carries it
// (e.g. US-MA), HASC otherwise (e.g. US.CA). Same gid rule as process.js's admin1.
async function loadAdmin1Regions() {
  const feats = await readShapefile('data/10m/ne_10m_admin_1_states_provinces.shp');
  const regions = [];
  for (const f of feats) {
    if (!f.geometry) continue;
    // NE marks self-invented placeholder codes with a trailing '~' (Kosovo's XK-X20~) —
    // strip it, matching the gid rule in process.js, so those regions still tag cities.
    const iso = (clean(f.properties.iso_3166_2) || '').replace(/~+$/, '');
    const hasc = (clean(f.properties.code_hasc) || '').replace(/~+$/, '');
    // Accept only well-formed ISO 3166-2 (US-MA) or HASC (US.CA); leftover junk like
    // "-99-X11" (Somaliland) still fails the pattern and is skipped.
    const gid = (iso && /^[A-Z]{2}-[A-Z0-9]+$/.test(iso)) ? iso
              : (hasc && /^[A-Z]{2}\.[A-Z0-9.]+$/.test(hasc)) ? hasc
              : null;
    if (!gid) continue;
    regions.push({ gid, bbox: bboxOf(f.geometry), geometry: f.geometry });
  }
  return regions;
}

function regionForPoint(regions, lng, lat) {
  for (const r of regions) {
    const b = r.bbox;
    if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) continue;
    if (geomContains(lng, lat, r.geometry)) return r.gid;
  }
  return null;
}

// Every city is tagged by point-in-polygon against the admin1 layer above (including NE's
// cleaned placeholder codes like XK-X20, so the gid always matches the regions layer).
// The single remaining null is Hargeysa: NE codes all of Somaliland as junk ("-99-X11~")
// and no ISO/HASC scheme exists for it — there is nothing consistent to assign.

async function main() {
  console.log('Reading country attributes...');
  const countryRecords = await readDbf('data/10m/ne_10m_admin_0_countries.dbf');

  console.log('Computing country areas from 10m shapefile geometry...');
  const countryFeatures = await readShapefile('data/10m/ne_10m_admin_0_countries.shp');
  const areaByGid = {};
  for (const f of countryFeatures) {
    // Shapefile properties are not cleaned like DBF records — clean strings before gid()
    const p = {};
    for (const [k, v] of Object.entries(f.properties)) p[k] = typeof v === 'string' ? clean(v) : v;
    const key = gid(p);
    areaByGid[key] = (areaByGid[key] || 0) + featureAreaKm2(f.geometry);
  }

  const props = {};
  const adm0A3ToGid = {};

  for (const r of countryRecords) {
    if (NO_GEOMETRY.has(r.ADM0_A3)) continue;

    const key = gid(r);
    adm0A3ToGid[r.ADM0_A3] = key;

    const patch = ISO_PATCHES[r.ADM0_A3];
    const rawName = (r.NAME && r.NAME.includes('.') && r.NAME_LONG) ? r.NAME_LONG : r.NAME;
    const name = NAME_PATCHES[r.ADM0_A3] || rawName;
    props[key] = {
      name: name || null,
      nameOfficial: nullIfMissing(r.FORMAL_EN) || r.NAME_LONG || r.NAME || null,
      iso2: patch ? patch.a2 : nullIfMissing(r.ISO_A2),
      iso3: (patch && patch.a3) || nullIfMissing(r.ISO_A3_EH) || nullIfMissing(r.ISO_A3),
      isoNum: patch
        ? (patch.n3 ? String(patch.n3).padStart(3, '0') : null)
        : (+r.ISO_N3 > 0 ? String(r.ISO_N3).padStart(3, '0') : null),
      continent: r.CONTINENT || null,
      subregion: r.SUBREGION || null,
      areakm2: areaByGid[key] || null,
      capital: null,
      capitalLat: null,
      capitalLng: null,
      landlocked: LANDLOCKED.has(key) || undefined,
    };
  }

  // Add split territories (overseas departments etc.) that don't appear in admin_0_countries
  for (const [key, data] of Object.entries(SPLIT_TERRITORY_PROPS)) {
    props[key] = {
      name: data.name,
      nameOfficial: data.nameOfficial,
      iso2: data.iso2,
      iso3: data.iso3,
      isoNum: data.isoNum,
      continent: data.continent,
      subregion: data.subregion,
      areakm2: SPLIT_TERRITORY_AREAS[key] || null,
      capital: null,
      capitalLat: null,
      capitalLng: null,
    };
  }

  console.log(`  ${Object.keys(props).length} countries/territories loaded`);

  console.log('Reading populated places...');
  const places = await readShapefile('data/10m/ne_10m_populated_places.shp');

  console.log('Loading admin1 regions for point-in-polygon region tagging...');
  const admin1Regions = await loadAdmin1Regions();
  console.log(`  ${admin1Regions.length} admin1 regions loaded`);

  // Unified city point set: every capital (regardless of population) plus every
  // populated place at or above the threshold. Capitals carry capital:true; each
  // point is stamped with the admin1 region that contains it and its continent.
  const cityPoints = [];
  let capitalCount = 0;

  for (const f of places) {
    const p = f.properties;
    const [lng, lat] = f.geometry.coordinates;
    const isCapital = p.FEATURECLA === CAPITAL_CLASS;
    const country = props[adm0A3ToGid[p.ADM0_A3]] || null;

    // Capital name/coords are also denormalized onto the country's properties entry
    if (isCapital && country) {
      country.capital = p.NAMEASCII;
      country.capitalLat = +lat.toFixed(4);
      country.capitalLng = +lng.toFixed(4);
    }

    if (!isCapital && (p.POP_MAX || 0) < CITY_POP_THRESHOLD) continue;
    if (isCapital) capitalCount++;

    cityPoints.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [+lng.toFixed(4), +lat.toFixed(4)] },
      properties: {
        name: p.NAMEASCII,
        nameLocal: p.NAME !== p.NAMEASCII ? p.NAME : null,
        countryIso2: country?.iso2 || null,
        countryName: country?.name || null,
        continent: country?.continent || null,
        region: regionForPoint(admin1Regions, lng, lat),
        popMetro: p.POP_MAX || null, // Natural Earth POP_MAX — metropolitan/urban-agglomeration population
        capital: isCapital, // true for national capitals, false otherwise — always present
      },
    });
  }

  const withRegion = cityPoints.filter((c) => c.properties.region).length;
  console.log(`  ${cityPoints.length} city points (${capitalCount} capitals, ${withRegion} with a region)`);

  console.log('Merging mledoze/countries (currencies, languages, idd, demonym)...');
  const mledoze = loadMledoze();
  let mledozeMatched = 0;
  for (const entry of Object.values(props)) {
    const fields = mledozeFields(entry.iso2 ? mledoze[entry.iso2] : null);
    Object.assign(entry, fields);
    if (fields.currencies || fields.languages || fields.idd || fields.demonym) mledozeMatched++;
  }
  console.log(`  ${mledozeMatched} of ${Object.keys(props).length} matched`);

  fs.writeFileSync(
    'processed/properties.json',
    JSON.stringify(props, null, 2)
  );
  console.log('✓ processed/properties.json');

  fs.writeFileSync(
    'processed/points/city.json',
    JSON.stringify({ type: 'FeatureCollection', features: cityPoints })
  );
  console.log('✓ processed/points/city.json');

  console.log('Done. Run: npm run upload  (or npm run pipeline to redo all steps)');
}

main().catch((err) => { console.error(err); process.exit(1); });
