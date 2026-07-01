/**
 * Converts Natural Earth shapefiles → topojson files in processed/.
 *
 * Each base topojson is stripped to the minimum fields needed by the Worker:
 *   - gid: join key (ISO_N3 numeric code for countries, iso_a2+adm1 slug for admin1)
 *   - disputed: bool — true for breakaway/disputed zones (excluded by API default)
 *   - cont: continent string — used for region= filtering in the Worker
 *
 * All other attributes (name, capital, ISO codes, etc.) are merged at request
 * time from properties.json via the Worker. They are NOT stored in these files.
 */

const path = require('path');
const fs = require('fs');
const mapshaper = require('mapshaper');

// In the Natural Earth admin_0_countries DBF:
//   TYPE  (uppercase, with trailing spaces) — distinguishes country types
//   CONTINENT, ISO_N3, ADM0_A3, ISO_A2  — uppercase
//   featurecla  — lowercase, always "Admin-0 country" in this file (useless for filtering)
//
// In admin_1_states_provinces DBF: all fields are lowercase (iso_a2, adm1_code, name, etc.)

// TYPE values (trimmed) that should be flagged disputed=true
const DISPUTED_TYPES = new Set(['Disputed', 'Indeterminate']);

// TYPE values (trimmed) to exclude entirely from the base files
const EXCLUDE_TYPES = new Set(['Lease']);

async function run(cmdStr) {
  return new Promise((resolve, reject) => {
    mapshaper.runCommands(cmdStr, (err) => (err ? reject(err) : resolve()));
  });
}

async function processCountries(res, inFile, mapUnitsFile, outFile) {
  const excludeList = [...EXCLUDE_TYPES].map((t) => `TYPE.trim() == '${t}'`).join(' || ');
  const disputedList = [...DISPUTED_TYPES].map((t) => `TYPE.trim() == '${t}'`).join(' || ');

  const tmpMain = `/tmp/pj_main_${res}.topojson`;
  const tmpFra  = `/tmp/pj_fra_${res}.topojson`;
  const tmpNor  = `/tmp/pj_nor_${res}.topojson`;

  // 1. All countries except France and Norway — handled separately via map_units
  await run(
    `-i ${inFile} ` +
    `-filter "!(${excludeList}) && ADM0_A3.trim() != 'FRA' && ADM0_A3.trim() != 'NOR'" ` +
    `-each "disputed = (${disputedList}); gid = String(+ISO_N3 > 0 ? ISO_N3 : 'x-' + ADM0_A3.trim()); cont = CONTINENT; iso2 = (ISO_A2 == '-99' ? null : ISO_A2)" ` +
    `-filter-fields gid,disputed,cont,iso2 ` +
    `-o format=topojson ${tmpMain}`
  );

  // 2. France — split into metropolitan France + overseas departments from map_units.
  //    map_units uses ISO 3166-2 subdivision codes (FR-973 etc.) — patch to ISO 3166-1 (GF, GP…).
  //    Réunion's CONTINENT is 'Seven seas' in NE data — patch to Africa.
  await run(
    `-i ${mapUnitsFile} ` +
    `-filter "ADM0_A3.trim() == 'FRA'" ` +
    `-each "disputed = (TYPE.trim() == 'Disputed'); ` +
           `gid = String(SU_A3.trim() == 'FXX' ? 250 : +ISO_N3); ` +
           `cont = (SU_A3.trim() == 'REU' || SU_A3.trim() == 'MYT' ? 'Africa' : CONTINENT); ` +
           `iso2 = (SU_A3.trim() == 'FXX' ? 'FR' : SU_A3.trim() == 'GUF' ? 'GF' : SU_A3.trim() == 'GLP' ? 'GP' : SU_A3.trim() == 'MTQ' ? 'MQ' : SU_A3.trim() == 'REU' ? 'RE' : SU_A3.trim() == 'MYT' ? 'YT' : null)" ` +
    `-filter-fields gid,disputed,cont,iso2 ` +
    `-o format=topojson ${tmpFra}`
  );

  // 3. Norway — split into Norway proper + Svalbard (+ Jan Mayen at 50m/10m).
  //    Svalbard and Jan Mayen share ISO code SJ / 744.
  await run(
    `-i ${mapUnitsFile} ` +
    `-filter "ADM0_A3.trim() == 'NOR'" ` +
    `-each "disputed = false; ` +
           `gid = String(SU_A3.trim() == 'NOR' ? 578 : 744); ` +
           `cont = 'Europe'; ` +
           `iso2 = (SU_A3.trim() == 'NOR' ? 'NO' : 'SJ')" ` +
    `-filter-fields gid,disputed,cont,iso2 ` +
    `-o format=topojson ${tmpNor}`
  );

  // 4. Merge all three into one topojson
  await run(
    `-i ${tmpMain} ${tmpFra} ${tmpNor} combine-files ` +
    `-merge-layers ` +
    `-o format=topojson ${outFile}`
  );
  console.log(`  ✓ ${outFile}`);
}

async function processAdmin1(res, inFile, outFile) {
  // admin1 fields are all lowercase; adm1_code is already 'ARG-1309' style
  await run(
    `-i ${inFile} ` +
    `-each "gid = adm1_code; iso2 = iso_a2" ` +
    `-filter-fields gid,iso2,name ` +
    `-o format=topojson ${outFile}`
  );
  console.log(`  ✓ ${outFile}`);
}

async function processPhysical(layer, inFile, outFile) {
  // Coastlines have no name fields — only lakes/rivers do
  const nameCmd = layer === 'coastlines'
    ? ''
    : `-each "name = (name_en || name)" `;
  const fields = layer === 'coastlines' ? 'featurecla' : 'featurecla,name';
  await run(
    `-i ${inFile} ` +
    nameCmd +
    `-filter-fields ${fields} ` +
    `-o format=topojson ${outFile}`
  );
  console.log(`  ✓ ${outFile}`);
}

async function main() {
  const resolutions = ['110m', '50m', '10m'];

  const shpName = {
    countries: {
      '110m': 'ne_110m_admin_0_countries',
      '50m': 'ne_50m_admin_0_countries',
      '10m': 'ne_10m_admin_0_countries',
    },
    mapUnits: {
      '110m': 'ne_110m_admin_0_map_units',
      '50m': 'ne_50m_admin_0_map_units',
      '10m': 'ne_10m_admin_0_map_units',
    },
    admin1: {
      '110m': 'ne_110m_admin_1_states_provinces',
      '50m': 'ne_50m_admin_1_states_provinces',
      '10m': 'ne_10m_admin_1_states_provinces',
    },
    lakes: {
      '110m': 'ne_110m_lakes',
      '50m': 'ne_50m_lakes',
      '10m': 'ne_10m_lakes',
    },
    rivers: {
      '110m': 'ne_110m_rivers_lake_centerlines',
      '50m': 'ne_50m_rivers_lake_centerlines',
      '10m': 'ne_10m_rivers_lake_centerlines',
    },
    coastlines: {
      '110m': 'ne_110m_coastline',
      '50m': 'ne_50m_coastline',
      '10m': 'ne_10m_coastline',
    },
  };

  const detailMap = { '110m': 'low', '50m': 'medium', '10m': 'high' };

  console.log('Processing countries...');
  for (const res of resolutions) {
    const inFile = `data/${res}/${shpName.countries[res]}.shp`;
    const mapUnitsFile = `data/${res}/${shpName.mapUnits[res]}.shp`;
    const outFile = `processed/countries/${detailMap[res]}.topojson`;
    if (!fs.existsSync(inFile)) { console.warn(`  skipping ${inFile} (not found)`); continue; }
    if (!fs.existsSync(mapUnitsFile)) { console.warn(`  skipping ${mapUnitsFile} (not found — run download.sh)`); continue; }
    await processCountries(res, inFile, mapUnitsFile, outFile);
  }

  console.log('Processing admin-1 subdivisions...');
  for (const res of resolutions) {
    const inFile = `data/${res}/${shpName.admin1[res]}.shp`;
    const outFile = `processed/admin1/${detailMap[res]}.topojson`;
    if (!fs.existsSync(inFile)) { console.warn(`  skipping ${inFile} (not found)`); continue; }
    await processAdmin1(res, inFile, outFile);
  }

  for (const layer of ['lakes', 'rivers', 'coastlines']) {
    console.log(`Processing physical — ${layer}...`);
    for (const res of resolutions) {
      const inFile = `data/${res}/${shpName[layer][res]}.shp`;
      const outFile = `processed/physical/${layer}/${detailMap[res]}.topojson`;
      if (!fs.existsSync(inFile)) { console.warn(`  skipping ${inFile} (not found)`); continue; }
      await processPhysical(layer, inFile, outFile);
    }
  }

  console.log('Done. Run: npm run build-props');
}

main().catch((err) => { console.error(err); process.exit(1); });
