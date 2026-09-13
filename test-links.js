/**
 * Check 4: every external data URL the site fetches is still browser-reachable.
 *
 * Example pages fetch third-party datasets at runtime. When a source moves,
 * nothing on our side changes and nothing fails — the page just dies in the
 * visitor's browser. That is how the Our World in Data renewables example
 * broke: OWID renamed the grapher slug, the old URL started serving a 301,
 * and because the redirect carried no Access-Control-Allow-Origin the browser
 * refused to follow it.
 *
 * So this checks what a browser actually needs, not just "is it up":
 *   - the request is sent with an Origin header (without one, servers that
 *     block cross-origin requests answer perfectly happily — a plain curl
 *     misses it entirely)
 *   - redirects are NOT followed; a redirect without CORS headers is a
 *     browser-side failure even though the final URL is fine
 *   - a 200 without Access-Control-Allow-Origin is a failure too
 */

const fs = require('fs');
const path = require('path');

const ORIGIN = 'https://mapjson.com';
// Some endpoints (Wikidata) throttle anonymous library user-agents. Identify
// the checker the way their policy asks so we get the answer a browser gets.
const UA = 'mapjson-link-check/1.0 (https://mapjson.com; site example checker)';
const TIMEOUT_MS = 20000;
const CONCURRENCY = 8;

// Pulls URLs out of the calls that actually run in a browser, plus the ones
// hoisted into a const first (`const CDC = "https://…"`). Anything built from
// a template (`${lat}`, tile `{z}/{x}/{y}`) can't be checked as written.
const URL_PATTERNS = [
  /(?:fetch|d3\.(?:csv|tsv|json|text|xml|buffer))\(\s*["']([^"']+)["']/g,
  /(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*["'](https?:\/\/[^"']+)["']/g,
];

// Sources that only ever appear as templates in the pages, so the scanner
// cannot see a complete URL. These stand in for them — one concrete request
// per host, shaped like the real one. `cors: false` for the ones loaded as
// <img> (tiles, flags): an image tag renders fine without CORS headers, so
// requiring them here would report a failure that does not exist.
const EXTRA_URLS = [
  { url: 'https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&current=temperature_2m,weather_code,wind_speed_10m',
    where: 'capital-temps.html, radar.html' },
  // The World Bank pages build indicator URLs from a helper, so only the bare
  // indicator path is scannable. These pin the exact queries the pages issue.
  { url: 'https://api.worldbank.org/v2/country/all/indicator/NY.GDP.PCAP.CD?format=json&per_page=400&date=2023',
    where: 'wealth-and-health.html' },
  { url: 'https://api.worldbank.org/v2/country/all/indicator/SP.POP.TOTL?format=json&per_page=400&date=2023',
    where: 'wealth-and-health.html' },
  { url: 'https://api.worldbank.org/v2/country/all/indicator/SP.DYN.LE00.IN?format=json&per_page=20000&date=1960:2023',
    where: 'life-expectancy.html, wealth-and-health.html' },
  // driving-side.html builds its SPARQL URL with encodeURIComponent, so the
  // scanner cannot see it. Same query the page issues, kept short.
  { url: 'https://query.wikidata.org/sparql?format=json&query=' +
         encodeURIComponent('SELECT ?iso2 ?sideLabel WHERE { ?c wdt:P297 ?iso2 . ?c p:P1622 ?st . ' +
           '?st ps:P1622 ?side . FILTER NOT EXISTS { ?st pq:P582 ?end } ' +
           'SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }'),
    where: 'driving-side.html' },
  { url: 'https://flagpedia.net/data/flags/h240/ua.png', where: 'flag-guess.html', cors: false },
  { url: 'https://tile.openstreetmap.org/3/4/2.png', where: 'radar.html, spotlight.html, hormuz.html', cors: false },
  { url: 'https://a.basemaps.cartocdn.com/light_all/3/4/2.png', where: 'radar.html, spotlight.html, hormuz.html', cors: false },
  { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/3/2/4',
    where: 'radar.html, spotlight.html, hormuz.html', cors: false },
];

function htmlFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...htmlFiles(full));
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

// Code sections carry an HTML-escaped copy of the same URL; unescaping makes
// the two collapse to one entry instead of being checked twice.
const unescapeHtml = (s) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

function collectUrls(root) {
  const urls = new Map(); // url -> { method, cors, files: Set }
  for (const file of htmlFiles(root)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const pattern of URL_PATTERNS) {
      for (const m of src.matchAll(pattern)) {
        const url = unescapeHtml(m[1]);
        if (!url.startsWith('http')) continue;      // relative asset
        if (url.includes('${') || url.includes('{')) continue; // templated
        // `const BASE = "…?query=" + encodeURIComponent(q)` leaves a bare prefix
        // behind; it is not an endpoint, so checking it just reports a fake 400.
        if (/[?&=]$/.test(url)) continue;
        // /v1/resolve and friends are POST-only — a GET would 404 misleadingly.
        const method = /method\s*:\s*["']POST["']/i.test(src.slice(m.index, m.index + 240))
          ? 'POST' : 'GET';
        if (!urls.has(url)) urls.set(url, { method, cors: true, files: new Set() });
        urls.get(url).files.add(path.relative(root, file));
      }
    }
  }
  for (const { url, where, cors = true } of EXTRA_URLS) {
    if (!urls.has(url)) urls.set(url, { method: 'GET', cors, files: new Set([where]) });
  }
  return urls;
}

async function probe(url) {
  const res = await fetch(url, {
    headers: { Origin: ORIGIN, 'User-Agent': UA },
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // Never read the body — some of these are multi-megabyte GeoJSON.
  await res.body?.cancel().catch(() => {});
  return res;
}

// A cross-origin JSON POST is gated by the preflight, so that is what we test:
// exactly the OPTIONS request the browser sends before the real call.
async function checkPreflight(url) {
  let res;
  try {
    res = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGIN,
        'User-Agent': UA,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => {});
  } catch (err) {
    return { level: 'fail', msg: `preflight failed — ${err.message}` };
  }
  if (!res.ok) return { level: 'fail', msg: `preflight HTTP ${res.status}` };
  if (!res.headers.get('access-control-allow-origin')) {
    return { level: 'fail', msg: 'preflight has no Access-Control-Allow-Origin' };
  }
  const allow = res.headers.get('access-control-allow-methods') || '';
  if (!/post/i.test(allow)) {
    return { level: 'fail', msg: `preflight does not allow POST (${allow || 'no header'})` };
  }
  return { level: 'pass', msg: `${res.status} preflight` };
}

async function checkUrl(url, { method, cors: needsCors }) {
  if (method === 'POST') return checkPreflight(url);

  let res;
  try {
    res = await probe(url);
  } catch (err) {
    return { level: 'fail', msg: `request failed — ${err.message}` };
  }

  const cors = res.headers.get('access-control-allow-origin');

  if (res.status >= 300 && res.status < 400) {
    const to = res.headers.get('location') || '(no Location)';
    if (!needsCors) return { level: 'warn', msg: `${res.status} redirect to ${to}` };
    return cors
      ? { level: 'warn', msg: `${res.status} redirect to ${to} — point the page at the final URL` }
      : { level: 'fail', msg: `${res.status} redirect to ${to} with no CORS header — the browser blocks it` };
  }
  if (!res.ok) return { level: 'fail', msg: `HTTP ${res.status}` };
  if (needsCors && !cors) {
    return { level: 'fail', msg: `${res.status} but no Access-Control-Allow-Origin — browser-blocked` };
  }
  return { level: 'pass', msg: `${res.status}` };
}

async function mapPool(items, worker, limit) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i]);
      }
    })
  );
  return results;
}

// Tells "the network is down" apart from "this source is dead", so running
// tests on a plane warns instead of reporting phantom breakage.
async function online() {
  const hosts = ['https://api.mapjson.com/v1/catalog?layer=countries', 'https://example.com'];
  for (const host of hosts) {
    try {
      const res = await fetch(host, { method: 'GET', signal: AbortSignal.timeout(8000) });
      await res.body?.cancel().catch(() => {});
      return true;
    } catch {}
  }
  return false;
}

async function checkLinks({ pass, fail, warn }, root) {
  const urls = collectUrls(root);
  if (urls.size === 0) return warn('no external fetch URLs found to check');

  if (!(await online())) {
    return warn(`skipped ${urls.size} URL(s) — no network`);
  }

  const list = [...urls.keys()].sort();
  const results = await mapPool(list, (url) => checkUrl(url, urls.get(url)), CONCURRENCY);

  list.forEach((url, i) => {
    const { level, msg } = results[i];
    const where = [...urls.get(url).files].join(', ');
    const short = url.length > 96 ? url.slice(0, 93) + '…' : url;
    if (level === 'pass') pass(`${msg}  ${short}`);
    else if (level === 'warn') warn(`${short}\n        ${msg}  [${where}]`);
    else fail(`${short}\n        ${msg}  [${where}]`);
  });
}

module.exports = { checkLinks, collectUrls };

// Standalone: `npm run test:links`
if (require.main === module) {
  let failures = 0;
  const fail = (m) => { console.error('  FAIL  ' + m); failures++; };
  const pass = (m) => console.log('  ok    ' + m);
  const warn = (m) => console.log('  warn  ' + m);
  console.log('External data sources reachable from a browser');
  checkLinks({ pass, fail, warn }, path.join(__dirname, 'docs')).then(() => {
    console.log('\n' + (failures === 0 ? 'All links OK.' : `${failures} link(s) failed.`));
    process.exit(failures > 0 ? 1 : 0);
  });
}
