# Claude Code Prompt — mapjson.com Ontology & Join API (Germany MVP)

Copy everything below the line into Claude Code.

---

Build a complete working MVP of a **place-ontology-powered geo data-join service**. The product: users upload a CSV with a messy geographic name column (e.g. "München", "Koeln", "Frankfurt a.M.", "Bavaria"), and the API resolves each value against a place knowledge graph, joins the user's data onto boundary polygons, and returns GeoJSON/TopoJSON plus a match report. The knowledge graph learns from usage: every confirmation/correction becomes evidence that improves future matching. Scope the data to **Germany** for this MVP.

## Stack (use exactly this)

- **Backend**: Python 3.11+, FastAPI, SQLAlchemy 2.x, Alembic migrations
- **Database**: PostgreSQL 16 with `pg_trgm` and `pgvector` extensions (provide docker-compose)
- **Geometry storage**: local filesystem `./data/geometries/` (S3-shaped interface so it can be swapped later)
- **Embeddings**: `sentence-transformers` (multilingual model, e.g. `paraphrase-multilingual-MiniLM-L12-v2`), vectors in pgvector
- **Frontend**: single-page React app (Vite) with two views: (1) Join workflow, (2) Ontology explorer
- **Graph visualization**: **Cytoscape.js** (via `react-cytoscapejs`) for the ontology explorer, and **MapLibre GL JS** for map preview of joined results
- No LLM API calls in this MVP — use deterministic + trigram + embedding matching. Leave a clearly marked stub `llm_propose_alias()` for later.

## Data model (implement exactly; this is the core IP)

### Tables

**places**
- `id` TEXT PK, format `mj:{iso2}-{slug}-{era}` e.g. `mj:de-by-muenchen-current`
- `kind` ENUM: `admin_unit`, `statistical_unit`, `postal_zone`, `colloquial_region`, `electoral_district`, `urban_agglomeration`, `historical_unit`
- `preferred_label` TEXT (endonym, e.g. `München`)
- `country` CHAR(3) (ISO alpha-3)
- `valid_from` DATE NULL, `valid_to` DATE NULL (NULL valid_to = current)
- `centroid_lat`, `centroid_lng` FLOAT
- `population` INT NULL, `population_year` INT NULL
- `status` ENUM: `canonical`, `provisional`, `deprecated`

**admin_levels** (a place can have several, scheme-scoped — never store a bare level)
- `place_id` FK, `scheme` TEXT (`mj-global`, `nuts`, `national-de`), `level` TEXT (e.g. `2`, `NUTS1`, `Land`, `Kreis`, `Gemeinde`)

**aliases** (nodes, not properties — they carry state and evidence)
- `id` UUID PK, `place_id` FK
- `surface_form` TEXT (exactly as observed), `normalized_form` TEXT (lowercase, diacritics folded, punctuation stripped)
- `language` TEXT (`de`, `en`, `und`...), `register` ENUM: `official`, `common`, `abbreviation`, `misspelling`, `historical`, `code`
- `state` ENUM: `quarantined`, `candidate`, `confirmed`
- `confidence` FLOAT (derived, see evidence model)
- `embedding` VECTOR(384)
- GIN trigram index on `normalized_form`

**external_ids**
- `place_id` FK, `system` TEXT (`wikidata`, `iso_3166_2`, `nuts`, `ags` [German Amtlicher Gemeindeschlüssel], `osm_relation`, `geonames`), `value` TEXT, `confidence` FLOAT

**edges**
- `id` UUID, `src_place_id` FK, `dst_place_id` FK
- `type` ENUM: `CONTAINS`, `OVERLAPS`, `SUCCEEDED_BY`, `SENSE_OF`
- `valid_from`, `valid_to` DATE NULL
- `properties` JSONB (containment %, split allocation %, mechanism for succession: `rename|merge|split|redraw`)

**evidence** (provenance for aliases and edges)
- `id` UUID, `target_type` ENUM(`alias`,`edge`,`external_id`), `target_id` UUID
- `source` ENUM: `official_gazetteer`, `user_confirmation`, `wikidata`, `usage_success`, `llm_proposal`
- `weight` FLOAT, `count` INT, `first_seen`, `last_seen` TIMESTAMPTZ
- Confidence formula: `confidence = 1 - Π(1 - min(weight_i * saturate(count_i), cap_i))` with per-source caps: official_gazetteer 0.95, user_confirmation 0.90, wikidata 0.70, usage_success 0.60, llm_proposal 0.30. Implement as a pure function with unit tests.

**geometry_versions**
- `place_id` FK, `valid_from`, `valid_to`, `source` TEXT, `simplification` ENUM(`full`,`medium`,`low`), `file_path` TEXT, `attribution` TEXT (geoBoundaries is CC-BY — store attribution, expose it in API responses)

**resolution_jobs** and **resolution_matches** (every join run, every per-value decision: candidates offered, scores, what the user picked, timestamps). This is the learning log.

**disambiguation_priors**
- `alias_normalized` TEXT, `place_id` FK, `context_signature` JSONB (e.g. `{"dominant_country":"DEU","dominant_level":"3","cooccurring_forms":["frankfurt a.m."]}`), `weight` FLOAT, `observation_count` INT

## Seed pipeline (Germany)

Write `scripts/seed_germany.py` that:
1. Downloads geoBoundaries for DEU at ADM0 (country), ADM1 (16 Länder), ADM2 (Kreise/kreisfreie Städte). Use the geoBoundaries API (`https://www.geoboundaries.org/api/current/gbOpen/DEU/ADM1/` etc.). Store full geometry + a mapshaper/shapely-simplified medium and low version per place. Record attribution.
2. Creates place nodes with `kind=admin_unit`, `national-de` scheme levels (`Land`, `Kreis`/`Kreisfreie Stadt`) and `mj-global` levels (1, 2), plus ADM0.
3. Builds `CONTAINS` edges from the geoBoundaries hierarchy (point-in-polygon of child centroid in parent as fallback check).
4. Seeds aliases: the official name (register=`official`, source=`official_gazetteer`), plus a curated static file `data/seed_aliases_de.json` you must author containing at least: English exonyms (Munich, Cologne, Bavaria, Lower Saxony, North Rhine-Westphalia...), common ASCII-folded misspellings (Koeln, Muenchen, Duesseldorf), standard abbreviations (NRW, BW, BY, RLP, MV, "Frankfurt a.M."), and codes (ISO 3166-2 DE-BY etc., AGS keys for the Länder). Mark registers correctly.
5. Computes embeddings for all normalized alias forms.
6. Idempotent: re-running updates, never duplicates.

Also create `scripts/seed_wikidata_crosswalk.py` (stub with clear TODO is acceptable if SPARQL is flaky, but attempt: pull DE Länder + Kreise Q-ids, multilingual labels as `wikidata`-sourced aliases in quarantine/candidate state, and external_ids).

## Resolution engine (`app/resolution/`)

Dataset-level, not row-level:
1. **Normalize** values (casefold, strip diacritics via `unicodedata`, collapse whitespace/punctuation, expand a small abbreviation table: `a.M.` → `am Main`, `St.` → `Sankt`).
2. **Candidates per value**: (a) exact normalized match; (b) trigram similarity > 0.35 via `pg_trgm`; (c) pgvector cosine top-5. Union, dedupe by place.
3. **Dataset priors** computed once: country distribution of confident matches, dominant admin level, kind distribution.
4. **Score**: `alias_confidence × string_sim × country_prior × level_prior × log-population prior × disambiguation_prior(context)`. Weights in a config dict; write the scorer as a pure, unit-tested function.
5. **Decisions**: score ≥ 0.9 and gap-to-second ≥ 0.15 → auto-match; 0.6–0.9 → `needs_review` with ranked candidates; < 0.6 → `unmatched` (logged to curation queue).
6. **Structural checks** on the accepted set: mixed admin levels (offer roll-up via CONTAINS, exclusion, or flag), duplicate referents (München + Munich → merge with sum/mean choice), and report them.
7. Persist everything to resolution_jobs/matches.

## Learning loop

- `POST /jobs/{id}/matches/{id}/confirm` and `/correct` endpoints. Confirmation adds `user_confirmation` evidence to the alias (creating the alias in `candidate` state if the surface form was new). Correction adds negative signal (reduce usage evidence) on the wrong alias, positive on the right one, and upserts a `disambiguation_prior` capturing the dataset context.
- Auto-promotion job: alias reaches `confirmed` when confidence ≥ 0.85 with confirmations from ≥ 2 distinct jobs. Never delete conflicting aliases — same surface form may legitimately point to multiple places; the context scorer disambiguates.
- Curation queue endpoint: `GET /curation/unmatched` returns failed surface forms ranked by frequency.

## API endpoints (FastAPI, OpenAPI docs on)

- `POST /v1/join` — multipart CSV or JSON body; params: `geo_column` (or `auto` — detect by trying resolution on a sample of each text column and picking the highest match rate), `target_level`, `output` (`geojson`|`topojson`), `aggregate` (`sum`|`mean`). Returns job id + immediate result if no reviews needed.
- `GET /v1/jobs/{id}` — status, match report (matched/fuzzy/unmatched counts, warnings), download links.
- `GET /v1/jobs/{id}/result.{geojson|topojson}` — boundaries with user data joined into `properties`, plus attribution.
- `POST /v1/jobs/{id}/matches/{match_id}/confirm|correct`
- `GET /v1/places/{id}` — node + aliases + edges + external ids + geometry links.
- `GET /v1/places/{id}/graph?depth=2` — subgraph in Cytoscape.js JSON format (nodes + edges with types/confidence) for the explorer.
- `GET /v1/ontology/stats` — counts by node/edge/alias state, evidence totals, growth over time (for the "watch it learn" view).
- `GET /v1/curation/unmatched`
- Use TopoJSON via `topojson` Python package or shell out to `geo2topo`; pick one and document it.

## Frontend (React + Vite, `web/`)

**View 1 — Join workflow**: drag-drop CSV → column auto-detect confirmation → progress → match report table (green auto-matches, yellow needs-review rows with ranked candidate dropdowns and confirm buttons, red unmatched) → MapLibre choropleth preview of the joined result (color by the first numeric column) → download buttons.

**View 2 — Ontology explorer (the "see it learn" view)**:
- Cytoscape.js graph: places as nodes (color by kind, size by population), edges styled by type (CONTAINS solid, ALIAS_OF dashed thin from small alias nodes, SUCCEEDED_BY arrows). Search box → center on place. Click node → side panel with properties, aliases grouped by state (quarantined/candidate/confirmed, with confidence bars), evidence list per alias.
- A "learning feed": recent evidence events (e.g. "alias 'Koeln' + user_confirmation from job #12, confidence 0.62 → 0.78") polled from a `GET /v1/ontology/events` endpoint (add an `events` table written by the evidence layer).
- Stats bar: total places / aliases by state / confirmed-alias growth sparkline.

## Example data & demo script

Create `examples/`:
- `de_cities_messy.csv` — ~25 rows mixing: correct German names, exonyms (Munich, Cologne), ASCII foldings (Duesseldorf), abbreviations (Frankfurt a.M., NRW), one level-mismatch trap (Bavaria among cities), one ambiguity trap (bare "Frankfurt" alongside "Frankfurt a.M."), one duplicate-referent trap (München and Munich as separate rows), 2–3 garbage values.
- `de_laender_stats.csv` — clean 16-Länder dataset (happy path).
- `demo.sh` — starts everything, seeds, runs `de_cities_messy.csv` through the API via curl, prints the match report.
- README walkthrough: run the messy file, watch the review flow, confirm "Frankfurt" → Frankfurt (Oder), re-run the same file, and observe the improved auto-match — proving the learning loop end to end.

## Engineering requirements

- docker-compose: postgres (with pgvector image), api, web. `make setup && make seed && make dev` gets a working system.
- Alembic migrations for all tables; enums as PG enums.
- Unit tests (pytest): confidence formula, normalizer, scorer, promotion rules, the Frankfurt disambiguation scenario as an integration test.
- Type hints throughout; pydantic v2 schemas for all API IO.
- Config via `.env` (pydantic-settings).
- Every geometry response includes geoBoundaries CC-BY attribution.
- Clear module layout: `app/models`, `app/resolution`, `app/ontology` (evidence/promotion), `app/api`, `scripts/`, `web/`.

## Build order (work in this sequence, committing at each step)

1. docker-compose + migrations + models + confidence/evidence functions with tests
2. Germany seed pipeline (verify: 1 ADM0, 16 ADM1, ~400 ADM2, CONTAINS tree correct)
3. Resolution engine + tests (Frankfurt scenario must pass)
4. Join API + TopoJSON output
5. Learning endpoints + promotion job + events
6. React join workflow
7. Cytoscape ontology explorer + learning feed
8. Examples + demo script + README

Start with step 1. After each step, run the tests and show me a brief status before continuing.
