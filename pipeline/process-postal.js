/**
 * Processes Census ZCTA (ZIP Code Tabulation Area) boundaries into per-state
 * topojson files for the postal layer.
 *
 * - Source: cb_2020_us_zcta520_500k (already 1:500k generalized, public domain)
 * - Each ZCTA is assigned a parent state (US-XX) by largest land-area overlap
 *   using the Census ZCTA↔county relationship file (county GEOID prefix = state FIPS).
 *   A handful of ZCTAs genuinely cross state lines — largest overlap wins.
 * - Output: processed/postal/US-XX.topojson, feature props {gid, parent_gid, iso2}
 *   where gid is the bare 5-digit ZCTA code (join key, same convention as
 *   districts using bare FIPS). ~33k polygons across ~52 files.
 *
 * Run after: npm run download-postal. Then: npm run build-catalog
 */

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT    = path.join(__dirname, '..');
const DATA    = path.join(ROOT, 'data/postal');
const OUT_DIR = path.join(ROOT, 'processed/postal');
const SHP     = path.join(DATA, 'cb_2020_us_zcta520_500k.shp');
const REL     = path.join(DATA, 'tab20_zcta520_county20_natl.txt');

// State FIPS → USPS postal code (states + DC + island territories with ZCTAs)
const FIPS_TO_POSTAL = {
  '01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT','10':'DE',
  '11':'DC','12':'FL','13':'GA','15':'HI','16':'ID','17':'IL','18':'IN','19':'IA',
  '20':'KS','21':'KY','22':'LA','23':'ME','24':'MD','25':'MA','26':'MI','27':'MN',
  '28':'MS','29':'MO','30':'MT','31':'NE','32':'NV','33':'NH','34':'NJ','35':'NM',
  '36':'NY','37':'NC','38':'ND','39':'OH','40':'OK','41':'OR','42':'PA','44':'RI',
  '45':'SC','46':'SD','47':'TN','48':'TX','49':'UT','50':'VT','51':'VA','53':'WA',
  '54':'WV','55':'WI','56':'WY','60':'AS','66':'GU','69':'MP','72':'PR','78':'VI',
};

function assignStates() {
  const lines = fs.readFileSync(REL, 'utf8').replace(/^﻿/, '').split('\n');
  const header = lines[0].split('|');
  const iZcta   = header.indexOf('GEOID_ZCTA5_20');
  const iCounty = header.indexOf('GEOID_COUNTY_20');
  const iLand   = header.indexOf('AREALAND_PART');

  const best = new Map(); // zcta -> { land, state }
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('|');
    const zcta = cols[iZcta];
    const county = cols[iCounty];
    if (!zcta || !county) continue;
    const land = Number(cols[iLand]) || 0;
    const prev = best.get(zcta);
    if (!prev || land > prev.land) best.set(zcta, { land, state: county.slice(0, 2) });
  }

  const rows = ['gid,parent_gid,iso2'];
  let skipped = 0;
  for (const [zcta, { state }] of best) {
    const postal = FIPS_TO_POSTAL[state];
    if (!postal) { skipped++; continue; }
    rows.push(`${zcta},US-${postal},US`);
  }
  if (skipped) console.warn(`  ${skipped} ZCTAs skipped (unknown state FIPS)`);
  const csv = path.join(DATA, 'zcta-state.csv');
  fs.writeFileSync(csv, rows.join('\n'));
  console.log(`  ✓ ${best.size} ZCTAs assigned to states`);
  return csv;
}

function main() {
  if (!fs.existsSync(SHP) || !fs.existsSync(REL)) {
    console.error('Source data missing — run: npm run download-postal');
    process.exit(1);
  }
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('Assigning ZCTAs to states via county relationship file...');
  const csv = assignStates();

  console.log('Processing shapefile with mapshaper (this takes a few minutes)...');
  execFileSync('npx', [
    'mapshaper-xl', SHP,
    '-each', 'gid=ZCTA5CE20',
    '-filter-fields', 'gid',
    '-join', csv, 'keys=gid,gid', 'string-fields=gid,parent_gid,iso2',
    '-filter', 'parent_gid != null',
    '-simplify', '35%', 'keep-shapes',
    '-clean',
    '-split', 'parent_gid',
    '-o', 'singles', 'format=topojson', 'extension=.topojson', OUT_DIR,
  ], { stdio: 'inherit', cwd: ROOT });

  const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.topojson'));
  if (files.length === 0) { console.error('mapshaper produced no output'); process.exit(1); }
  const totalMB = files.reduce((s, f) => s + fs.statSync(path.join(OUT_DIR, f)).size, 0) / 1024 / 1024;
  console.log(`  ✓ ${files.length} state files, ${totalMB.toFixed(1)} MB total`);
  console.log('Done. Next: npm run build-catalog && node pipeline/upload-postal.js');
}

main();
