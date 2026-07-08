// Builds the resolver index from the mapjson catalog + curated alias files.
// Output: src/generated/hot.json, bundled into the worker at deploy time so
// parsing happens under the isolate startup budget, not the request CPU budget.
//
// Usage: node pipeline/build-index.js   (MAPJSON_REPO env overrides the default
// path to the mapjson repo root — this worker lives in ontology/ inside it)
//
// Sharding: v1 emits a single "hot" shard covering everything mapjson serves
// (~8k entities). When world ADM2 lands, per-country shards get emitted next to
// it and loaded lazily from R2 — the shard format is identical.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalize } from "../src/lib/normalize.js";
import { trigrams } from "../src/lib/trigram.js";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const MAPJSON = process.env.MAPJSON_REPO || here("../..");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const { existsSync } = await import("node:fs");
const catalog = {
  countries: readJson(`${MAPJSON}/processed/catalog/countries.json`),
  regions: readJson(`${MAPJSON}/processed/catalog/regions.json`),
  districts: readJson(`${MAPJSON}/processed/catalog/districts.json`),
  postal: existsSync(`${MAPJSON}/processed/catalog/postal.json`)
    ? readJson(`${MAPJSON}/processed/catalog/postal.json`)
    : [],
};
const properties = readJson(`${MAPJSON}/processed/properties.json`);
const curated = {
  countries: readJson(here("../data/aliases/countries.json")),
  usStates: readJson(here("../data/aliases/us-states.json")),
  regions: readJson(here("../data/aliases/regions.json")),
};
for (const c of Object.values(curated)) delete c._comment;

// Bulk alternate spellings/names from a public-domain reference country
// dataset (not hand-curated — same addName mechanism, source="auto" so it's
// distinguishable in resolution logs from the curated lists above). Optional:
// only present if that sibling data file has been downloaded.
const ALTSPELLINGS_FILE = `${MAPJSON}/data/mledoze/countries.json`;
const altSpellings = {};
if (existsSync(ALTSPELLINGS_FILE)) {
  for (const c of readJson(ALTSPELLINGS_FILE)) {
    if (c.cca2 && c.altSpellings?.length) altSpellings[c.cca2] = c.altSpellings;
  }
} else {
  console.warn(`  ${ALTSPELLINGS_FILE} not found — skipping bulk alt-spellings`);
}

// ---------------------------------------------------------------- entities

const entities = [];
const gidIndex = {}; // gid -> entity idx

function addEntity(e) {
  gidIndex[e.gid] = entities.length;
  entities.push(e);
}

const clean = (v) => (v && v !== "-1" && v !== "-99" ? v : null);

for (const c of catalog.countries) {
  addEntity({
    gid: c.gid,
    name: c.name,
    layer: "countries",
    parent: null,
    country: clean(c.iso2) ?? c.gid,
    iso2: clean(c.iso2),
    iso3: clean(c.iso3),
    isoNum: clean(c.isoNum),
    continent: c.continent ?? null,
  });
}
for (const r of catalog.regions) {
  addEntity({
    gid: r.gid,
    name: r.name,
    layer: "regions",
    parent: clean(r.parent_gid),
    country: clean(r.iso2),
    gidSource: r.gid_source ?? null,
  });
}
for (const d of catalog.districts) {
  addEntity({
    gid: d.gid,
    name: d.name,
    layer: "districts",
    parent: clean(d.parent_gid),
    country: clean(d.iso2),
    fips: d.gid,
  });
}
// ZCTAs collide with county FIPS as bare strings ("01001" is both Autauga
// County AL and a ZIP in Agawam MA), so postal entity ids are namespaced.
// geoKey is the bare code — the join key the geo API's features carry.
for (const z of catalog.postal) {
  addEntity({
    gid: `US-${z.gid}`,
    geoKey: z.gid,
    name: z.gid,
    layer: "postal",
    parent: clean(z.parent_gid),
    country: clean(z.iso2),
    zcta: z.gid,
  });
}

// ------------------------------------------------------------- identifiers
// identifiers: normalized value -> [[scheme, entityIdx], ...]
// The same value legitimately maps to several scheme/entity pairs
// (postal "MA" = Massachusetts, iso2 "MA" = Morocco) — the resolver's
// context/consensus scoring disambiguates.

const identifiers = {};

function addIdentifier(scheme, value, idx) {
  if (value == null || value === "") return;
  const norm = normalize(value);
  if (!norm) return;
  const rows = (identifiers[norm] ??= []);
  if (!rows.some(([s, i]) => s === scheme && i === idx)) rows.push([scheme, idx]);
}

const unpad = (v) => v?.replace(/^0+(?=\d)/, "");

for (const [gid, idx] of Object.entries(gidIndex)) {
  const e = entities[idx];
  if (e.layer === "countries") {
    addIdentifier("iso2", e.iso2, idx);
    addIdentifier("iso3", e.iso3, idx);
    addIdentifier("isoNum", e.isoNum, idx);
    addIdentifier("isoNum", unpad(e.isoNum), idx);
    if (!e.iso2) addIdentifier("gid", gid, idx); // minted x-XXX gids
  } else if (e.layer === "regions") {
    const scheme = e.gidSource === "hasc" ? "hasc" : "iso_3166_2";
    addIdentifier(scheme, gid, idx);
  } else if (e.layer === "districts") {
    addIdentifier("fips", e.fips, idx);
    addIdentifier("fips", unpad(e.fips), idx);
  } else if (e.layer === "postal") {
    addIdentifier("zcta", e.zcta, idx);
    addIdentifier("zcta", unpad(e.zcta), idx); // spreadsheets strip ZIP leading zeros
  }
}

for (const [gid, spec] of Object.entries(curated.usStates)) {
  const idx = gidIndex[gid];
  if (idx == null) { console.warn(`us-states.json: unknown gid ${gid}`); continue; }
  addIdentifier("postal", spec.postal, idx);
  addIdentifier("fips_state", spec.fips, idx);
  addIdentifier("fips_state", unpad(spec.fips), idx);
  entities[idx].postal = spec.postal;
  entities[idx].fipsState = spec.fips;
}

// ------------------------------------------------------------------- names
// names: array of [normalizedName, [[entityIdx, nameType, source], ...]]

const nameRows = new Map(); // norm -> Map(entityIdx -> [type, source])
const TYPE_RANK = { official: 0, alias: 1 };

function addName(raw, idx, type, source) {
  if (raw == null || raw === "") return;
  const norm = normalize(raw);
  if (!norm) return;
  const posting = nameRows.get(norm) ?? new Map();
  const prev = posting.get(idx);
  if (!prev || TYPE_RANK[type] < TYPE_RANK[prev[0]]) posting.set(idx, [type, source]);
  nameRows.set(norm, posting);
}

for (const [gid, idx] of Object.entries(gidIndex)) {
  const e = entities[idx];
  if (e.layer === "postal") continue; // codes only — no names, keeps trigram index clean
  addName(e.name, idx, "official", "catalog");
  if (e.layer === "countries") {
    const p = properties[gid];
    if (p) {
      addName(p.name, idx, "official", "properties");
      addName(p.nameOfficial, idx, "official", "properties");
    }
  }
}

function addCurated(map, source) {
  for (const [gid, aliases] of Object.entries(map)) {
    const idx = gidIndex[gid];
    if (idx == null) { console.warn(`${source}: unknown gid ${gid}`); continue; }
    for (const a of aliases) addName(a, idx, "alias", source);
  }
}
addCurated(curated.countries, "countries.json");
addCurated(curated.regions, "regions.json");
addCurated(
  Object.fromEntries(Object.entries(curated.usStates).map(([g, s]) => [g, s.aliases ?? []])),
  "us-states.json"
);
addCurated(altSpellings, "auto");

const names = [...nameRows.entries()]
  .sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([norm, posting]) => [
    norm,
    [...posting.entries()]
      .sort(([a], [b]) => a - b)
      .map(([idx, [type, source]]) => [idx, type, source]),
  ]);

// -------------------------------------------------------- trigram inverted index

const trigramIndex = {};
names.forEach(([norm], nameIdx) => {
  if (norm.length < 3) return; // fuzzy matching on 1-2 chars is meaningless
  for (const t of trigrams(norm)) (trigramIndex[t] ??= []).push(nameIdx);
});

// ------------------------------------------------------------------- write

const index = {
  builtAt: new Date().toISOString(),
  counts: {
    entities: entities.length,
    identifierValues: Object.keys(identifiers).length,
    names: names.length,
    trigrams: Object.keys(trigramIndex).length,
  },
  entities,
  gidIndex,
  identifiers,
  names,
  trigrams: trigramIndex,
};

mkdirSync(here("../src/generated"), { recursive: true });
const out = here("../src/generated/hot.json");
const json = JSON.stringify(index);
writeFileSync(out, json);
console.log(`wrote ${out}`);
console.log(index.counts, `${(json.length / 1024 / 1024).toFixed(2)} MB raw`);
