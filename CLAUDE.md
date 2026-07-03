# mapjson — Claude instructions

## Deployment

There are **two separate deployments**. Never confuse them.

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

- `districts` always returns high resolution (Natural Earth only has 10m admin2)
- Country names in `filter` are resolved to ISO2 in the worker (`filter=Poland` = `filter=PL`)
- `properties` are merged from `properties.json` in R2 at request time
