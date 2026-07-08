/**
 * Consistency checks across the API, docs, and examples.
 *
 * 1. Every example .html file is linked from docs/examples/index.html
 * 2. Every layer= value used in any example exists in worker/src/validate.js VALID_LAYERS
 * 3. Every layer in VALID_LAYERS is documented in docs/docs.html
 */

const fs   = require('fs');
const path = require('path');

const ROOT     = __dirname;
const EXAMPLES = path.join(ROOT, 'docs/examples');
const INDEX    = path.join(EXAMPLES, 'index.html');
const VALIDATE = path.join(ROOT, 'worker/src/validate.js');
const DOCS     = path.join(ROOT, 'docs/docs/index.html');

// Files intentionally not listed in index.html (drafts, color variants, internal tools)
const UNLISTED_OK = /^(poland-v\d|validate-pipeline|africa-vs-russia)/;

let failures = 0;
function fail(msg) { console.error('  FAIL  ' + msg); failures++; }
function pass(msg) { console.log( '  ok    ' + msg); }
function warn(msg) { console.log( '  warn  ' + msg); }

// ── Parse VALID_LAYERS from validate.js ──────────────────────────────────────
const validateSrc  = fs.readFileSync(VALIDATE, 'utf8');
const layersMatch  = validateSrc.match(/VALID_LAYERS\s*=\s*new Set\(\[([^\]]+)\]\)/);
if (!layersMatch) { console.error('Could not parse VALID_LAYERS from validate.js'); process.exit(1); }
const validLayers  = new Set(
  [...layersMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1])
);

// ── Parse layer-name entries from docs.html ───────────────────────────────────
const docsSrc         = fs.readFileSync(DOCS, 'utf8');
const documentedLayers = new Set(
  [...docsSrc.matchAll(/<div class="layer-name">([^<]+)<\/div>/g)].map(m => m[1].trim())
);

// ── Parse links from examples/index.html ─────────────────────────────────────
const indexSrc    = fs.readFileSync(INDEX, 'utf8');
const linkedFiles = new Set(
  [...indexSrc.matchAll(/href="([a-z_-]+\.html)"/g)].map(m => m[1])
);
linkedFiles.delete('index.html');

// ── Scan all example files for layer= values ─────────────────────────────────
const exampleFiles = fs.readdirSync(EXAMPLES)
  .filter(f => f.endsWith('.html') && f !== 'index.html');

const layersUsedInExamples = new Set();
for (const file of exampleFiles) {
  const src = fs.readFileSync(path.join(EXAMPLES, file), 'utf8');
  for (const [, layer] of src.matchAll(/layer=([a-z-]+)/g)) {
    layersUsedInExamples.add(layer);
  }
}

// ── Check 1: example files ↔ index.html ──────────────────────────────────────
console.log('\nCheck 1: example files listed in index.html');
for (const linked of linkedFiles) {
  const exists = fs.existsSync(path.join(EXAMPLES, linked));
  exists ? pass(`${linked} exists`) : fail(`index.html links to ${linked} but file not found`);
}
for (const file of exampleFiles) {
  if (linkedFiles.has(file)) continue;
  UNLISTED_OK.test(file) ? warn(`${file} not in index.html (draft/variant)`)
                         : fail(`${file} exists but is not linked from index.html`);
}

// ── Check 2: layers used in examples ↔ VALID_LAYERS ─────────────────────────
console.log('\nCheck 2: layers used in examples exist in VALID_LAYERS');
for (const layer of layersUsedInExamples) {
  validLayers.has(layer) ? pass(`layer=${layer}`)
                         : fail(`examples use layer=${layer} but it is not in VALID_LAYERS`);
}

// ── Check 3: VALID_LAYERS ↔ docs.html ────────────────────────────────────────
console.log('\nCheck 3: all VALID_LAYERS documented in docs.html');
for (const layer of validLayers) {
  documentedLayers.has(layer) ? pass(`layer=${layer} documented`)
                              : fail(`layer=${layer} is in VALID_LAYERS but missing from docs.html`);
}

// ── Result ────────────────────────────────────────────────────────────────────
console.log('\n' + (failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`));
process.exit(failures > 0 ? 1 : 0);
