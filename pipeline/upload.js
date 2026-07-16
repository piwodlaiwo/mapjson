/**
 * Uploads processed/ files to Cloudflare R2 via wrangler CLI.
 * Run after: npm run process && npm run build-props
 *
 * Requires wrangler to be authenticated: cd worker && npx wrangler login
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROCESSED = path.join(__dirname, '../processed');
const WRANGLER = path.join(__dirname, '../worker/node_modules/.bin/wrangler');
const BUCKET = 'mapjson';

function upload(localPath, r2Key) {
  console.log(`  → r2://${BUCKET}/${r2Key}`);
  // --remote is required: wrangler v4 defaults `r2 object put` to the LOCAL simulated
  // bucket, so without it the production bucket is never updated.
  execSync(`${WRANGLER} r2 object put ${BUCKET}/${r2Key} --file="${localPath}" --remote`, {
    cwd: path.join(__dirname, '../worker'),
    stdio: 'pipe',
  });
}

function walk(dir, base = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walk(full, rel);
    } else if (entry.name.endsWith('.topojson') || entry.name.endsWith('.json')) {
      upload(full, rel);
    }
  }
}

console.log('Uploading processed/ to R2...');
walk(PROCESSED);
console.log('Done.');
