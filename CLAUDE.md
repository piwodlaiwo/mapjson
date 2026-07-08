# mapjson — Claude instructions

## Deployment

There are **three separate deployments**. Never confuse them.

### Docs site → GitHub Pages
- URL: `https://mapjson.com`
- Source: `docs/` directory
- **Deploy: `git add … && git commit && git push origin main`**
- GitHub Actions rebuilds Pages automatically on push
- `npm run deploy` from the root does NOT deploy the docs site

### API Worker → Cloudflare Workers
- URL: `https://api.mapjson.com` (live), `https://mapjson.mapjson.workers.dev` (dev)
- Source: `worker/src/`
- **Deploy: `cd worker && npm run deploy`** (uses `worker/wrangler.toml`, name: `mapjson`)
- Dev server: `cd worker && npm run dev`

### Ontology Worker → Cloudflare Workers (key resolution)
- No public hostname of its own — reached through `api.mapjson.com` via the geo
  worker's `ONTOLOGY` service binding (see `worker/wrangler.toml`)
- Source: `ontology/src/`
- **Deploy: `cd ontology && npm run deploy`** (runs `build-index` first, then
  `wrangler deploy` using `ontology/wrangler.toml`, name: `mapjson-ontology`)
- Resolves messy keys ("Mass", "Deutschland", FIPS codes...) to gids for the
  Clean/Explore/Build tools and `/v1/resolve`. Its build step
  (`ontology/pipeline/build-index.js`) reads this repo's own
  `processed/catalog/*.json`, `processed/properties.json`, and (optionally)
  `data/mledoze/countries.json` — run the root pipeline first if those are stale
- Has its own D1 database (`mapjson-ontology`) and test suite (`cd ontology && npm test`)

### Root `wrangler.jsonc` — pipeline worker only
- Name: `mapjson-pipeline`, URL: `mapjson-pipeline.mapjson.workers.dev`
- Serves the `docs/` directory as a Workers Assets site for testing
- This is NOT `mapjson.com` and is NOT the API
- Running `npm run deploy` from the root targets this — not the docs, not the API worker

## Project structure

```
mapjson/
├── docs/                  # GitHub Pages site (mapjson.com)
│   ├── index.html         # Homepage with live globe map
│   ├── docs.html          # API reference
│   └── examples/          # Example maps
│       └── index.html     # Examples gallery — must stay in sync with example files
├── worker/                # Cloudflare API worker (api.mapjson.com)
│   ├── src/
│   │   ├── index.js       # Request handler, routing
│   │   ├── validate.js    # Param validation, VALID_LAYERS
│   │   ├── filter.js      # Feature filtering by layer/filter
│   │   └── merge-props.js # Merges properties.json onto features
│   └── wrangler.toml      # Worker config — always pass --config wrangler.toml
├── ontology/              # Key-resolution worker (reached via api.mapjson.com)
│   ├── src/index.js       # /v1/resolve, /v1/feedback, /v1/entities, /v1/curation
│   ├── pipeline/build-index.js  # Builds src/generated/hot.json from this
│   │                             # repo's processed/ catalog + properties.json
│   ├── data/aliases/      # Hand-curated key aliases (countries/regions/US states)
│   └── wrangler.toml      # Own D1 database; no public route (service binding only)
├── pipeline/              # Offline data processing (run locally)
│   ├── download.sh        # Fetch Natural Earth shapefiles
│   ├── process.js         # mapshaper: convert + simplify
│   ├── build-properties.js
│   └── upload.js          # Push processed topojson to R2 bucket
├── test.js                # Consistency check: examples ↔ VALID_LAYERS ↔ docs.html
└── wrangler.jsonc         # Pipeline worker config — NOT the API, NOT docs
```

## R2 storage

- Bucket: `mapjson` (bound as `GEO_BUCKET` in the worker)
- Layout: `countries/{low,medium,high}.topojson`, `admin1/{low,medium,high}.topojson`, `districts/high.topojson`, `physical/{lakes,rivers,coastlines}/{low,medium,high}.topojson`, `properties.json`
- Upload via: `node pipeline/upload.js`

## Consistency rule

After adding a new layer or example, always run `npm test` before deploying. It checks:
1. Every example file is linked from `docs/examples/index.html`
2. Every `layer=` used in examples exists in `worker/src/validate.js` `VALID_LAYERS`
3. Every `VALID_LAYERS` entry is documented in `docs/docs.html`

## API quick reference

```
GET https://api.mapjson.com/v1/geo
  ?layer=countries|regions|districts|lakes|rivers|coastlines
  &filter=world|europe|asia|africa|north-america|south-america|oceania|{ISO2}|{country name}
  &detail=low|medium|high|ultra
  &properties=name,iso2,...
  &format=topojson|geojson
```

- `districts` always returns high resolution regardless of `detail` param (Natural Earth only has 10m admin2)
- `filter` accepts ISO 3166-2 region codes for districts: `filter=US-MA` returns only Massachusetts counties
- Country names in `filter` are resolved to ISO2 in the worker (`filter=Poland` = `filter=PL`)
- `properties` are merged from `properties.json` in R2 at request time

## Adding a new country property

- **Naming convention**: lowercase, single token — `areakm2`, `iso2`, `capital` — not camelCase. (`nameOfficial`, `capitalLat`, `capitalLng`, `isoNum` predate this convention; don't use them as a template for new keys.)
- Key matching against `?properties=` is an **exact, case-sensitive string match** against `ALL_PROP_KEYS` (see `worker/src/merge-props.js`) — there is no normalization in `validate.js`. A mismatched case (e.g. `areaKm2` vs `areakm2`) is silently dropped from the response with no error, same as an unrecognized key.

When adding a new opt-in property, these places must ALL be updated or the property silently disappears:

1. **`pipeline/build-properties.js`** — compute and store the value in `props[key]`
2. **`worker/src/merge-props.js`** — add the key to `ALL_PROP_KEYS` (the allowlist that gates what `mergeProperties` returns)
3. **`docs/docs.html`** — add the key to the `properties` options list in the params table AND add a row to the Properties section below — both exist and can drift independently
4. **Regenerate and ship the data**: `npm run build-props` (rebuilds `processed/properties.json` locally) → `npm run upload` (pushes it to R2) → `cd worker && npm run deploy` (redeploys the worker so the new allowlist key takes effect) — steps 1–3 alone only change source files, not the live API

Missing step 2 means the API silently ignores the property even though it's in properties.json. Missing step 4 means the code is correct but the live API still doesn't reflect it.

## Example pages

- Example code blocks must be **full standalone HTML** starting with `<!DOCTYPE html>` — not partial snippets
- Map background color must **contrast with the choropleth color scheme** — never use a blue background with a blue (`d3.interpolateBlues`) choropleth; use a warm neutral (e.g. `#d4cfc8`) instead
- County/region border stroke should complement the fill palette — cream (`#f4efe8`) works against blue fills; dark (`#3a5e70`) works against light land fills
