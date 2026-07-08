# Build Prompt: mapjson.com Ontology & Resolution Layer

You are building the **place ontology and key-resolution layer** for mapjson.com, a web-first mapping API that serves pre-simplified TopoJSON via single-call endpoints. This layer resolves messy, real-world geographic keys in user datasets (e.g. `"Mass"`, `"US-MA"`, `"25"`, `"Georgia"`) onto the correct stable entity IDs that mapjson's boundary topology uses. It is the product's core proprietary asset, so correctness, explainability, and a feedback loop for continuous curation matter more than raw feature count.

## Problem Statement

Users bring tabular data keyed by whatever their source system used: postal abbreviations, FIPS codes, ISO 3166-2, colloquial names, misspellings, or a mix. mapjson's topology is keyed by stable native hierarchical IDs. Without resolution, users must manually re-key their data before they can render a map. The ontology layer accepts a batch of user keys plus context and returns confident, explainable mappings to native entity IDs — including disambiguating collisions like "Georgia" (US state vs. country) or "MA" (Massachusetts vs. Morocco) using batch context.

## Tech Stack (fixed — do not substitute)

- **PostgreSQL 15+** with the `pg_trgm` extension. No Neo4j, no RDF/triple stores, no OWL tooling.
- **Python 3.11+** for the resolver service and ingestion pipelines. Use `psycopg` (v3), `pydantic` v2 for models, `FastAPI` for the HTTP interface, `pytest` for tests.
- Plain SQL migrations in numbered files (e.g. `migrations/001_init.sql`) applied by a small runner script. No heavyweight migration framework required.
- Package everything with `pyproject.toml`; keep the project installable with `pip install -e .`.

## Repository Layout

```
ontology/
  pyproject.toml
  README.md
  migrations/
    001_init.sql
  src/mapjson_ontology/
    db.py               # connection pooling, migration runner
    models.py           # pydantic models: Entity, Identifier, Name, Edge, ResolutionRequest/Result
    resolver.py         # the scoring resolver (core IP)
    api.py              # FastAPI app: POST /resolve, GET /entities/{id}, POST /feedback
    ingest/
      geonames.py       # GeoNames dump ingestion
      wikidata.py       # Wikidata identifier crosswalk ingestion
      iso_tables.py     # ISO 3166-1/-2 + UN M49 static tables
    misslog.py          # resolution miss/low-confidence logging + curation queue queries
  tests/
    test_resolver.py
    test_ingest.py
    fixtures/           # small sample dumps for tests (create synthetic ones)
```

## Database Schema (P0)

Create these tables in `migrations/001_init.sql`:

### `entities`
- `id TEXT PRIMARY KEY` — mapjson native hierarchical ID (e.g. `us`, `us-ma`, `us-ma-025`). Treat as opaque stable strings.
- `entity_type TEXT NOT NULL CHECK (entity_type IN ('country','admin_1','admin_2','map_unit','dependency','disputed'))`
- `canonical_name TEXT NOT NULL`
- `layer TEXT` — which mapjson topology layer this entity's geometry lives in (e.g. `world-countries`, `us-states`, `us-counties`). Nullable for entities without geometry yet.
- `geometry_key TEXT` — the object key inside that layer's TopoJSON.
- `valid_from DATE`, `valid_to DATE` — nullable; supports boundary changes over time.
- `metadata JSONB DEFAULT '{}'`
- `created_at`, `updated_at` timestamps.

### `identifiers`
- `entity_id TEXT REFERENCES entities(id) ON DELETE CASCADE`
- `scheme TEXT NOT NULL` — e.g. `iso_3166_1_a2`, `iso_3166_1_a3`, `iso_3166_2`, `fips`, `un_m49`, `postal`, `geonames_id`, `wikidata_qid`, `osm_relation`
- `value TEXT NOT NULL`
- `PRIMARY KEY (scheme, value)` — a code is unique within its scheme. **Note:** the same string may exist under different schemes (postal `MA` vs iso_3166_1_a2 `MA`) — that is expected and is exactly what the resolver disambiguates.
- Index on `entity_id`.

### `names`
- `id BIGSERIAL PRIMARY KEY`
- `entity_id TEXT REFERENCES entities(id) ON DELETE CASCADE`
- `name TEXT NOT NULL`
- `normalized_name TEXT NOT NULL` — lowercased, unaccented (use `unaccent` extension), whitespace-collapsed. Generated in application code at insert time.
- `language TEXT` — BCP-47 or NULL
- `name_type TEXT NOT NULL CHECK (name_type IN ('official','short','colloquial','abbreviation','historical','misspelling'))`
- `source TEXT` — where this alias came from (`geonames`, `wikidata`, `curation`, `misslog`)
- `UNIQUE (entity_id, normalized_name, name_type)`
- GIN trigram index: `CREATE INDEX ON names USING gin (normalized_name gin_trgm_ops);`

### `edges`
- `parent_type TEXT`, `child` relationships as rows: `(from_entity, to_entity, edge_type)`
- `edge_type TEXT NOT NULL CHECK (edge_type IN ('parent_of','part_of_map_unit','succeeded_by','equivalent_to'))`
- `PRIMARY KEY (from_entity, to_entity, edge_type)`
- `valid_from DATE`, `valid_to DATE` nullable.

### `resolution_log`
- Every `/resolve` call's per-key outcome: `(id, request_id, raw_key, detected_scheme, resolved_entity_id NULL, confidence NUMERIC, status CHECK (status IN ('resolved','ambiguous','miss','low_confidence')), context JSONB, created_at)`
- This is the curation queue. Index on `status` and `created_at`.

## The Resolver (P0 — this is the core IP)

Implement `resolve(keys: list[str], context: ResolutionContext) -> list[ResolutionResult]` in `resolver.py`.

`ResolutionContext` fields (all optional): `layer` (requested topology layer), `scheme_hint`, `parent_hint` (e.g. `us`), `country_bias` (list of country IDs).

**Pipeline per batch:**

1. **Normalize** each key (trim, lowercase, unaccent, collapse whitespace).
2. **Candidate generation** per key, in tiers:
   - Tier 1: exact match in `identifiers.value` (case-insensitive), any scheme.
   - Tier 2: exact match on `names.normalized_name`.
   - Tier 3: trigram similarity on `names.normalized_name` with `similarity > 0.45`, top 5.
3. **Scoring** each candidate: base score by tier (1.0 / 0.9 / similarity value), then multiply by context factors:
   - `+` candidate's `layer` matches `context.layer`
   - `+` candidate's parent (via `parent_of` edge) matches `context.parent_hint`
   - `+` candidate's scheme matches `context.scheme_hint`
4. **Batch consensus pass (the differentiator):** after individual scoring, compute the distribution of `(entity_type, parent)` across all keys' top candidates. Re-score each key's candidates with a consensus bonus when they match the dominant type/parent. Example that must work: a batch of 50 keys where 49 resolve to US states must resolve `"Georgia"` to the US state and `"MA"` to Massachusetts even with no explicit context hints.
5. **Decision:** top candidate with score ≥ 0.8 and margin ≥ 0.15 over the runner-up → `resolved`. Top candidate below 0.8 → `low_confidence` (return it with the score, flagged). Multiple candidates within the margin → `ambiguous` (return top 3 candidates with scores). No candidates → `miss`.
6. **Log** every outcome to `resolution_log`.

Every `ResolutionResult` must include an `explanation` field: which tier matched, which name/identifier row, and which context/consensus factors applied. Resolution must be deterministic — same input, same output.

## HTTP API (P0)

- `POST /resolve` — body `{keys: [...], context: {...}}`, returns per-key results with entity ID, geometry_key, layer, confidence, status, explanation.
- `GET /entities/{id}` — entity with its identifiers, names, and direct edges.
- `POST /feedback` — `{request_id, raw_key, correct_entity_id}`; writes a `misspelling`/`colloquial` alias row (source=`misslog`) and marks the log row curated. This is the flywheel.

## Ingestion (P0: ISO tables + GeoNames; P1: Wikidata)

- `iso_tables.py`: embed ISO 3166-1 (alpha-2, alpha-3, numeric) and UN M49 as static data; create country entities and identifiers. For ISO 3166-2 US states, also create admin_1 entities with `parent_of` edges from `us`, plus postal and FIPS identifiers and standard aliases.
- `geonames.py`: parse the GeoNames `allCountries.txt` + `alternateNamesV2.txt` dump formats (tab-separated; implement against small synthetic fixture files in tests — do not download real dumps in CI). Match GeoNames records to existing entities via the `geonames_id` identifier or admin-code joins; insert alternate names into `names`.
- `wikidata.py` (P1): stub the module with a documented interface for ingesting identifier crosswalks (QID → ISO/FIPS/GeoNames/OSM) from a pre-filtered JSONL file; implement the JSONL ingestion path.
- All ingestion must be idempotent (upserts) and record `source`.

## Seed Data (P0)

Ship a `seed.py` script that, without any external downloads, loads: all ~250 ISO countries, all 50 US states + DC + territories with FIPS/postal/ISO codes and common aliases (including `Mass`, `Calif`, `N.Y.`, etc. — curate a reasonable starter list), and `parent_of` edges. This makes the demo case work out of the box.

## Tests (P0)

- The "Georgia problem": batch of US state keys + `"Georgia"` resolves to the US state; a batch of country names + `"Georgia"` resolves to the country.
- `"MA"` in a US-states batch → Massachusetts; `"MA"` alone with `scheme_hint=iso_3166_1_a2` → Morocco.
- `"Mass"` → `us-ma` via alias; `"Massachusets"` (typo) → `us-ma` via trigram with `low_confidence` or `resolved` depending on score.
- Miss logging: unresolvable key appears in `resolution_log` with status `miss`; `POST /feedback` creates the alias and a re-run resolves it.
- Idempotent ingestion: running seed twice produces no duplicates.

## Non-Goals (v1)

- No geometry processing or TopoJSON generation — this layer only maps keys to entity IDs / geometry keys.
- No ML/embeddings — trigram similarity only. Design `resolver.py` so an embedding candidate tier could be added later (keep candidate generation pluggable).
- No admin UI for curation — the curation queue is queryable via SQL/endpoint; UI comes later.
- No multi-tenant auth — assume the API sits behind mapjson's existing gateway.

## Working Style

- Start with the migration + models, then resolver with tests, then API, then ingestion.
- Keep the resolver pure-ish: candidate generation hits the DB; scoring and consensus are pure functions over candidate lists so they are trivially unit-testable.
- Write a README covering: setup, running migrations, seeding, example `/resolve` curl calls demonstrating the Georgia disambiguation, and how the feedback flywheel works.
