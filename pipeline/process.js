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
const shapefile = require('shapefile');

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

// ISO alpha-2 assignments for territories Natural Earth ships without one
// (ISO_A2 = -99). X-codes are from the ISO 3166 user-assigned range; every one
// of these is flagged disputed=true so they stay out of default API responses.
// Taiwan gets its real ISO code (Natural Earth carries China's POV, 'CN-TW').
// Keep in sync with ISO_PATCHES in build-properties.js.
const ISO2_OVERRIDES = {
  TWN: 'TW',
  ESB: 'XD', SOL: 'XS', BRI: 'XB', CYN: 'XC', CNM: 'XZ', KAS: 'XG',
  WSB: 'XA', SPI: 'XF', BRT: 'XT', CLP: 'XL', CSI: 'XO', PGA: 'XP',
  ATC: 'XH', BJN: 'XN', SER: 'XE', SCR: 'XR',
};
const FORCE_DISPUTED = Object.keys(ISO2_OVERRIDES).filter((k) => k !== 'TWN');

// Object/array literals for use inside mapshaper -each "…" expressions —
// single quotes only, since the expression itself is double-quoted.
const iso2OverridesExpr = '{' + Object.entries(ISO2_OVERRIDES)
  .map(([k, v]) => `${k}:'${v}'`).join(',') + '}';
const forceDisputedExpr = '[' + FORCE_DISPUTED.map((k) => `'${k}'`).join(',') + ']';

async function run(cmdStr) {
  return new Promise((resolve, reject) => {
    mapshaper.runCommands(cmdStr, (err) => (err ? reject(err) : resolve()));
  });
}

async function processCountries(res, inFile, mapUnitsFile, outFile) {
  const excludeList = [...EXCLUDE_TYPES].map((t) => `TYPE.trim() == '${t}'`).join(' || ');
  const disputedList = [...DISPUTED_TYPES].map((t) => `TYPE.trim() == '${t}'`).join(' || ');

  const tmpMain   = `/tmp/pj_main_${res}.topojson`;
  const tmpFra    = `/tmp/pj_fra_${res}.topojson`;
  const tmpNor    = `/tmp/pj_nor_${res}.topojson`;
  const tmpExtra  = `/tmp/pj_extra_${res}.topojson`;
  const tmpMAR    = `/tmp/pj_mar_${res}.topojson`;
  const tmpESH_S  = `/tmp/pj_esh_s_${res}.topojson`;
  const tmpSAH2   = `/tmp/pj_sah2_${res}.topojson`;
  const tmpESH    = `/tmp/pj_esh_${res}.topojson`;
  const tmpMerged = `/tmp/pj_merged_${res}.topojson`;

  // Simplification intervals matched to Natural Earth resolution levels.
  // DIVA-GIS data is high-res so we simplify down to avoid over-detailed polygons in the
  // global low/medium files. The 10m (high) level keeps near-full DIVA-GIS resolution.
  const simplifyInterval = { '110m': '50km', '50m': '20km', '10m': '5km' };
  const interval = simplifyInterval[res];

  // 1. All countries except those replaced surgically.
  //    MAR (Morocco) and SAH (Western Sahara) are excluded here because Natural Earth
  //    maps them using de facto control (Morocco's polygon extends to Mauritania). They
  //    are re-added from DIVA-GIS below using the internationally recognised de jure boundary.
  await run(
    `-i ${inFile} ` +
    `-filter "!(${excludeList}) && ADM0_A3.trim() != 'FRA' && ADM0_A3.trim() != 'NOR' && ADM0_A3.trim() != 'NLD' && ADM0_A3.trim() != 'NZL' && ADM0_A3.trim() != 'IOA' && ADM0_A3.trim() != 'MAR' && ADM0_A3.trim() != 'SAH'" ` +
    `-each "disputed = (${disputedList}) || ${forceDisputedExpr}.indexOf(ADM0_A3.trim()) > -1; iso2 = ${iso2OverridesExpr}[ADM0_A3.trim()] || (ADM0_A3.trim() == 'KOS' ? 'XK' : ISO_A2 == '-99' ? null : ISO_A2); gid = iso2 || ('x-' + ADM0_A3.trim()); cont = CONTINENT" ` +
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
           `iso2 = (SU_A3.trim() == 'FXX' ? 'FR' : SU_A3.trim() == 'GUF' ? 'GF' : SU_A3.trim() == 'GLP' ? 'GP' : SU_A3.trim() == 'MTQ' ? 'MQ' : SU_A3.trim() == 'REU' ? 'RE' : SU_A3.trim() == 'MYT' ? 'YT' : null); ` +
           `gid = iso2; ` +
           `cont = (SU_A3.trim() == 'REU' || SU_A3.trim() == 'MYT' ? 'Africa' : CONTINENT)" ` +
    `-filter-fields gid,disputed,cont,iso2 ` +
    `-o format=topojson ${tmpFra}`
  );

  // 3. Norway — split into Norway proper (NO) + Svalbard & Jan Mayen (SJ, shared ISO 744).
  //    Key on SUBUNIT: it is the only field stable across resolutions. SU_A3 is 'NOR' at
  //    110m/50m but 'NOW' at 10m, and ISO_A2 is '-99' for the mainland at 110m/50m but
  //    'NO' at 10m — keying on either dropped Norway proper and produced SJ ×4 at 10m.
  //    Bouvet Island (ISO 'BV', a NOR map_unit at 10m only) is excluded — not a tracked territory.
  await run(
    `-i ${mapUnitsFile} ` +
    `-filter "ADM0_A3.trim() == 'NOR' && SUBUNIT.trim() != 'Bouvet Island'" ` +
    `-each "disputed = false; ` +
           `iso2 = (SUBUNIT.trim() == 'Norway' ? 'NO' : 'SJ'); ` +
           `gid = iso2; ` +
           `cont = 'Europe'" ` +
    `-filter-fields gid,disputed,cont,iso2 ` +
    `-o format=topojson ${tmpNor}`
  );

  // 4. NLD, NZL, IOA — ISO_N3 and ISO_A2 are already correct in map_units except for
  //    Netherlands proper at 10m (SU_A3=NLX has ISO_A2=-99, ISO_N3=-99) — patch it.
  //    IOA (Indian Ocean Territories of Australia) splits into CX + CC with no parent
  //    feature — it produces no output here and has no properties.json entry either
  //    (build-properties.js excludes it entirely; there's nothing to attach it to).
  await run(
    `-i ${mapUnitsFile} ` +
    `-filter "ADM0_A3.trim() == 'NLD' || ADM0_A3.trim() == 'NZL' || ADM0_A3.trim() == 'IOA'" ` +
    `-each "disputed = false; ` +
           `iso2 = (SU_A3.trim() == 'NLX' ? 'NL' : (ISO_A2 == '-99' ? null : ISO_A2)); ` +
           `gid = iso2 || ('x-' + SU_A3.trim()); ` +
           `cont = CONTINENT" ` +
    `-filter-fields gid,disputed,cont,iso2 ` +
    `-o format=topojson ${tmpExtra}`
  );

  // 5+6. Morocco and Western Sahara — clipped entirely within Natural Earth data so
  //       borders with Algeria, Mauritania and the coastline remain consistent.
  //       Mixing DIVA-GIS with Natural Earth creates coordinate mismatches at every
  //       shared border with neighbouring countries, causing visible gaps.
  //
  //       Approach: clip Natural Earth Morocco (MAR) at the internationally recognised
  //       boundary (~27.667°N). The portion above becomes Morocco; the portion below is
  //       merged with the existing SAH (Polisario eastern strip) polygon to form the full
  //       Western Sahara territory. The result is a clean horizontal de jure border.
  const WS_LAT = 27.667;

  // Morocco proper: Natural Earth MAR clipped above the de jure line
  await run(
    `-i ${inFile} -filter "ADM0_A3.trim() == 'MAR'" ` +
    `-clip bbox=-180,${WS_LAT},180,90 ` +
    `-each "disputed=false; iso2='MA'; gid='MA'; cont='Africa'" ` +
    `-filter-fields gid,disputed,cont,iso2 ` +
    `-o format=topojson ${tmpMAR}`
  );

  // Western Sahara part 1: the coastal strip — Natural Earth MAR clipped below the line
  await run(
    `-i ${inFile} -filter "ADM0_A3.trim() == 'MAR'" ` +
    `-clip bbox=-180,-90,180,${WS_LAT} ` +
    `-each "disputed=true; iso2='EH'; gid='EH'; cont='Africa'" ` +
    `-filter-fields gid,disputed,cont,iso2 ` +
    `-o format=topojson ${tmpESH_S}`
  );

  // Western Sahara part 2: Natural Earth SAH (Polisario-controlled eastern strip)
  await run(
    `-i ${inFile} -filter "ADM0_A3.trim() == 'SAH'" ` +
    `-each "disputed=true; iso2='EH'; gid='EH'; cont='Africa'" ` +
    `-filter-fields gid,disputed,cont,iso2 ` +
    `-o format=topojson ${tmpSAH2}`
  );

  // Merge both WS parts into one feature, dissolving the shared interior border
  await run(
    `-i ${tmpESH_S} ${tmpSAH2} combine-files -merge-layers ` +
    `-dissolve ` +
    `-each "disputed=true; iso2='EH'; gid='EH'; cont='Africa'" ` +
    `-filter-fields gid,disputed,cont,iso2 ` +
    `-o format=topojson ${tmpESH}`
  );

  // 7. Merge all six parts into the final output.
  await run(
    `-i ${tmpMain} ${tmpFra} ${tmpNor} ${tmpExtra} ${tmpMAR} ${tmpESH} combine-files ` +
    `-merge-layers ` +
    `-o format=topojson ${outFile}`
  );
  console.log(`  ✓ ${outFile}`);
}

async function processAdmin1(res, inFile, outFile) {
  const simplifyInterval = { '110m': '50km', '50m': '20km', '10m': '5km' };
  const interval = simplifyInterval[res];

  // Natural Earth admin1 — include all countries. Morocco regions come from Natural Earth
  // admin1 (consistent with the country boundary approach above). Western Sahara's 4
  // provinces are added separately from the SAH/MAR split used at country level, but since
  // Natural Earth admin1 doesn't have Western Sahara entries, we use DIVA-GIS adm1 for EH
  // only (WS is a special case — no Natural Earth admin1 data exists for it at all).
  const tmpNE   = `/tmp/pj_adm1_ne_${res}.topojson`;
  const tmpESH1 = `/tmp/pj_adm1_esh_${res}.topojson`;

  // gid: ISO 3166-2 (e.g. US-CA) where available in NE data; fall back to HASC (e.g. US.CA).
  // parent_gid: ISO alpha-2 country code — joins directly to countries layer gid.
  await run(
    `-i ${inFile} ` +
    `-each "gid = (iso_3166_2 && iso_3166_2 !== '-99') ? iso_3166_2 : hasc_1; parent_gid = iso_a2; iso2 = iso_a2" ` +
    `-filter-fields gid,parent_gid,iso2,name ` +
    `-o format=topojson ${tmpNE}`
  );

  // Western Sahara admin1 from DIVA-GIS — no Natural Earth equivalent exists
  await run(
    `-i data/iso/ESH/adm1.topo.json ` +
    `-simplify interval=${interval} keep-shapes ` +
    `-each "gid = 'EH-' + String(ID_1); parent_gid = 'EH'; iso2 = 'EH'; name = NAME_1" ` +
    `-filter-fields gid,parent_gid,iso2,name ` +
    `-o format=topojson ${tmpESH1}`
  );

  await run(
    `-i ${tmpNE} ${tmpESH1} combine-files ` +
    `-merge-layers ` +
    `-o format=topojson ${outFile}`
  );
  console.log(`  ✓ ${outFile}`);
}

// Builds a lookup from 2-digit FIPS state number → ISO 3166-2 (e.g. '53' → 'US-WA').
// The admin2 counties shapefile carries ISO_3166_2 as 'US-53' (FIPS-based),
// while the admin1 file carries iso_3166_2 as 'US-WA' (letter-based).
// We use the admin1 DBF to bridge between the two.
async function buildStateFipsToGid(admin1DbfFile) {
  const src = await shapefile.openDbf(admin1DbfFile, { encoding: 'utf-8' });
  const lookup = {};
  let result;
  while (!(result = await src.read()).done) {
    const r = result.value;
    const a2  = (r.iso_a2     || '').replace(/\0/g, '').trim();
    const fips = (r.fips      || '').replace(/\0/g, '').trim();
    const gid  = (r.iso_3166_2 || '').replace(/\0/g, '').trim();
    if (a2 === 'US' && fips && gid && gid !== '-99') {
      // fips is like 'US53' — extract the numeric part used in county ISO_3166_2 ('US-53')
      lookup[fips.replace('US', '')] = gid;
    }
  }
  return lookup;
}

async function processAdmin2(inFile, admin1DbfFile, outFile) {
  // Natural Earth admin2 is US-only (3,224 counties). CODE_LOCAL is the 5-digit FIPS code
  // which joins directly to Census/BLS data. We simplify to keep file size reasonable.
  // parent_gid: state ISO 3166-2 (US-WA, US-CA…) — joins directly to regions layer gid.
  const tmp = outFile.replace('.topojson', '_tmp.topojson');

  await run(
    `-i ${inFile} ` +
    `-simplify interval=2km keep-shapes ` +
    `-each "gid = CODE_LOCAL; state_iso = ISO_3166_2; iso2 = ISO_A2; name = NAME_EN || NAME" ` +
    `-filter-fields gid,state_iso,iso2,name ` +
    `-o format=topojson ${tmp}`
  );

  // Patch parent_gid using the FIPS → ISO3166-2 lookup from admin1
  const fipsToGid = await buildStateFipsToGid(admin1DbfFile);
  const topo = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  const key  = Object.keys(topo.objects)[0];
  for (const g of topo.objects[key].geometries) {
    const p = g.properties;
    const stateFips = (p.state_iso || '').replace('US-', '');
    p.parent_gid = fipsToGid[stateFips] || null;
    delete p.state_iso;
  }
  fs.writeFileSync(outFile, JSON.stringify(topo));
  fs.unlinkSync(tmp);
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

  console.log('Processing admin-2 districts...');
  {
    const inFile      = `data/10m/ne_10m_admin_2_counties_lakes.shp`;
    const admin1Dbf   = `data/10m/ne_10m_admin_1_states_provinces.dbf`;
    const outFile     = `processed/districts/high.topojson`;
    if (!fs.existsSync(inFile)) {
      console.warn(`  skipping ${inFile} (not found — run download.sh)`);
    } else {
      fs.mkdirSync('processed/districts', { recursive: true });
      await processAdmin2(inFile, admin1Dbf, outFile);
    }
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

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { processCountries };
