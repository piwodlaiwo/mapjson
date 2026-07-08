# mapjson keys

**Clean messy geographic data, then map it.** A standalone [mapjson](https://mapjson.com)
service that resolves real-world geographic keys — `Mass`, `Calif.`, `Koeln`, `Georgia`,
`25`, `US-MA` — onto the stable `gid`s that mapjson's boundary topology is keyed by,
plus the full ISO/FIPS identifier crosswalk.

- **UI**: https://keys.mapjson.com — paste keys or a CSV, review matches, download a cleaned CSV
- **API**: `POST https://keys.mapjson.com/v1/resolve`
- **Geo API it feeds into**: [api.mapjson.com/v1/geo](https://mapjson.com/docs/) (separate repo/worker)

Naming: the customer-facing brand is **mapjson keys**; the backing dataset (entities,
aliases, identifier crosswalk) is still called the *ontology* internally — hence this
repo, worker, and D1 name.

The typical flow: resolve your keys once → join your data to boundaries by `gid`,
exactly like every mapjson example already does.

## The Georgia problem (why this exists)

The same key means different things in different datasets. This resolver scores
candidates in batch: the *other* keys in your request disambiguate each one.

```bash
# A batch of US states: "Georgia" is the state
curl -s https://keys.mapjson.com/v1/resolve -H 'Content-Type: application/json' \
  -d '{"keys":["Alabama","California","Texas","Georgia","Mass","N.Y."]}'
# → Georgia → US-GA (resolved), Mass → US-MA, N.Y. → US-NY

# A batch of countries: "Georgia" is the country
curl -s https://keys.mapjson.com/v1/resolve -H 'Content-Type: application/json' \
  -d '{"keys":["France","Germany","Japan","Georgia"]}'
# → Georgia → GE (resolved)

# No context at all: honestly ambiguous, candidates returned
curl -s https://keys.mapjson.com/v1/resolve -H 'Content-Type: application/json' \
  -d '{"keys":["Georgia"]}'
# → status "ambiguous", candidates [GE, US-GA, 28039]
```

Every result carries an `explanation` (which tier matched, which alias, which
context/consensus factors applied) and is deterministic: same input, same output.

## API

### `POST /v1/resolve`

```json
{ "keys": ["Mass", "Calif.", "Georgia"], "context": { "layer": "regions", "country": "US" } }
```

- `keys` — 1–1,000 strings. Names, ISO2/ISO3/numeric, ISO 3166-2, FIPS (state or county),
  US ZIP codes (ZCTAs, leading-zero-stripped tolerated), postal abbreviations, misspellings.
- `context` (optional) — `layer` (`countries` | `regions` | `districts` | `postal`), `country` (ISO2),
  `parent` (a gid, e.g. `US-AL` for its counties).

Postal note: ZCTA codes collide with county FIPS as bare strings (`01001` is both Autauga
County AL and a ZIP in Agawam MA) — batch consensus or `context.layer` disambiguates.
Postal results return the bare ZIP as `gid` (the geo API join key) plus a namespaced
`entityId` (`US-01001`) for `/v1/entities` lookups.

Per-key response: `status` (`resolved` | `ambiguous` | `low_confidence` | `miss`),
`gid`, `name`, `layer`, `crosswalk` (iso2/iso3/isoNum/fips/postal…), `confidence`,
`explanation`, and ranked `candidates` when review is needed.

### `POST /v1/feedback`

```json
{ "key": "Koeln", "wrong_gid": null, "correct_gid": "DE-NW", "note": "city, roll up to state" }
```

Corrections land in the curation queue and become aliases in the next index build —
the flywheel that makes matching better over time.

### `GET /v1/entities/{gid}` — entity with all its identifiers and aliases.
### `GET /v1/entities/{gid}/graph?depth=1|2` — Cytoscape.js-format subgraph: ancestors,
children (capped at 400 nodes), and alias/code leaves with co-claimant entities.
Rendered at [/explorer](https://keys.mapjson.com/explorer) — search any messy key,
click nodes to refocus; red-dashed neighbors share a name or code with the focus.
### `GET /v1/health` — index build timestamp and counts.
### `GET /v1/curation/queue?token=…` — misses + uncurated feedback (set `CURATION_TOKEN` secret).

## Architecture

```
pipeline/build-index.js  (offline, Node)
  mapjson catalog + properties  ─┐
  data/aliases/*.json (curated) ─┴→ src/generated/hot.json
                                     · entities + identifier maps
                                     · normalized names
                                     · inverted trigram index

src/index.js  (Cloudflare Worker, keys.mapjson.com)
  bundled index (parsed at isolate startup, not per-request)
  POST /v1/resolve → tiers: identifier → exact name → trigram
                   → context multipliers → batch consensus → decision
  D1: resolution_log + feedback (writes only, via ctx.waitUntil)
```

Design notes:

- **The database never matches anything.** The entire read path is the compiled
  index; D1 only records outcomes and feedback. At mapjson's current scale
  (~8k entities) the index is ~400 KB gzipped and lives inside the worker script.
- **Sharded by design**: `hot.json` is the always-loaded shard. When mapjson grows
  world ADM2 (~50k entities), per-country shards load lazily from R2 with the same format.
- **Consensus scoring** is a pure function — see `src/resolver.js`, tested in
  `test/resolver.test.js` (the Georgia suite is the acceptance gate).

## Development

```bash
npm install
npm run build-index                                  # needs ../mapjson checked out (or MAPJSON_REPO=…)
npm test
npx wrangler d1 migrations apply mapjson-ontology --local
npm run dev                                          # http://localhost:8787
```

## Deploy

```bash
npx wrangler d1 create mapjson-ontology              # once; paste database_id into wrangler.toml
npx wrangler d1 migrations apply mapjson-ontology --remote
npx wrangler secret put CURATION_TOKEN               # once
npm run deploy                                       # build-index + wrangler deploy
```

`keys.mapjson.com` is attached as a Custom Domain on the worker (Cloudflare
dashboard → worker → Settings → Domains & Routes, or `[[routes]]` in wrangler.toml).
Everything runs on the Workers Free plan: bundled index, D1 free tier, no R2 needed yet.

## Curation runbook (the flywheel)

1. `GET /v1/curation/queue?token=…` — misses and corrections, ranked by frequency.
2. Accept the good ones by adding aliases to `data/aliases/*.json` (in git, reviewable).
3. `npm run deploy` — rebuilds the index and ships it.
4. Mark handled feedback: `UPDATE feedback SET curated_at = datetime('now') WHERE id IN (…)`
   via `wrangler d1 execute mapjson-ontology --remote --command "…"`.

Alias file formats: `countries.json` / `regions.json` are `{ gid: [aliases…] }`;
`us-states.json` adds `postal` + `fips` identifier fields per state.
