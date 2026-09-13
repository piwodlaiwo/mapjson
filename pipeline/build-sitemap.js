#!/usr/bin/env node
/**
 * Rebuilds docs/sitemap.xml from what the site actually contains.
 *
 * Example URLs come from the gallery (docs/examples/index.html), not from a
 * directory listing — the gallery is the definition of a published example, so
 * old variants left in the directory (poland-v1…v4) stay out, and a new example
 * is in the sitemap the moment its card is added.
 *
 * lastmod is each file's last commit date. Uncommitted files fall back to today,
 * which is what they will be committed as.
 *
 * Run: npm run build-sitemap
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const SITE = 'https://mapjson.com';

// Top-level pages, in the order they should be crawled: home first, then the
// docs and the tools. Each is a directory served as index.html.
const PAGES = ['', 'docs/', 'examples/', 'clean/', 'explorer/', 'build/', 'image-to-map/'];

function lastCommit(file) {
  const d = execSync(`git log --format=%ad --date=short -1 -- "${file}"`,
    { cwd: ROOT, encoding: 'utf8' }).trim();
  return d || new Date().toISOString().slice(0, 10);
}

const gallery = fs.readFileSync(path.join(DOCS, 'examples/index.html'), 'utf8');
const examples = [...new Set([...gallery.matchAll(/<a class="card[^"]*" href="([a-z0-9-]+\.html)"/g)]
  .map((m) => m[1]))];

const urls = [
  ...PAGES.map((p) => ({
    loc: `${SITE}/${p}`,
    file: path.join(DOCS, p, 'index.html'),
  })),
  ...examples.map((name) => ({
    loc: `${SITE}/examples/${name}`,
    file: path.join(DOCS, 'examples', name),
  })),
];

const body = urls.map(({ loc, file }) =>
  `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastCommit(path.relative(ROOT, file))}</lastmod>\n  </url>`
).join('\n');

fs.writeFileSync(path.join(DOCS, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`);

console.log(`sitemap.xml: ${urls.length} urls (${PAGES.length} pages + ${examples.length} examples)`);
