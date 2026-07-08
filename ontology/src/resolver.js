// The resolver: messy user keys -> mapjson entities, with confidence,
// explanation, and batch-consensus disambiguation. Pure functions over the
// bundled index — no I/O, deterministic (same input, same output), so the
// whole pipeline is unit-testable without a worker runtime.

import { normalize, stripDistrictSuffix } from "./lib/normalize.js";
import { trigrams, similarity } from "./lib/trigram.js";

// Scoring constants. Tier bases, then multiplicative context/consensus factors.
const TIER_IDENTIFIER = 1.0;
const TIER_EXACT_NAME = 0.9;
const FUZZY_MIN_SIM = 0.45;
const FUZZY_TOP_N = 5;

const CTX_LAYER_MISMATCH = 0.6; // explicit context.layer contradicted
const CTX_COUNTRY_MISMATCH = 0.5; // explicit context.country contradicted
const CTX_PARENT_MISMATCH = 0.6;

const CONSENSUS_MIN_BATCH = 3; // consensus is meaningless on tiny batches
const CONSENSUS_DOMINANCE = 0.5; // >50% of anchors must agree
const CONS_LAYER_MATCH = 1.1;
const CONS_LAYER_MISMATCH = 0.75;
const CONS_COUNTRY_MATCH = 1.05;
const CONS_COUNTRY_MISMATCH = 0.85;

const SCORE_CAP = 0.99;
const RESOLVED_MIN = 0.8;
const MARGIN = 0.15;

// Prominence prior: with no other signal, a bare "Texas" should rank the state
// above Texas County, MO, and "Georgia" the country above the US state. Far too
// small to flip a status — it only orders otherwise-tied candidates.
const LAYER_PRIOR = { countries: 1.0, regions: 0.995, districts: 0.99, postal: 0.985 };
const DISTRICT_SUFFIX_BONUS = 1.05;

// ---------------------------------------------------------------- candidates

function fuzzyCandidates(index, norm) {
  if (norm.length < 3) return [];
  const q = trigrams(norm);
  const hitCounts = new Map(); // nameIdx -> shared trigram count
  for (const t of q) {
    const postings = index.trigrams[t];
    if (postings) for (const idx of postings) hitCounts.set(idx, (hitCounts.get(idx) ?? 0) + 1);
  }
  const minHits = Math.max(2, Math.ceil(q.size * 0.3)); // cheap prefilter before real similarity
  const scored = [];
  for (const [nameIdx, hits] of hitCounts) {
    if (hits < minHits) continue;
    const [candNorm] = index.names[nameIdx];
    const sim = similarity(q, trigrams(candNorm));
    if (sim > FUZZY_MIN_SIM) scored.push([nameIdx, sim]);
  }
  scored.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  return scored.slice(0, FUZZY_TOP_N);
}

// Binary search over the sorted names array.
function findNameRow(index, norm) {
  const names = index.names;
  let lo = 0, hi = names.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = names[mid][0];
    if (v === norm) return mid;
    if (v < norm) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

// All candidates for one key: map entityIdx -> best candidate record.
function candidatesForKey(index, rawKey) {
  const norm = normalize(rawKey);
  const byEntity = new Map();

  const consider = (entityIdx, score, explanation) => {
    const prev = byEntity.get(entityIdx);
    if (!prev || score > prev.base) byEntity.set(entityIdx, { entityIdx, base: score, explanation });
  };

  if (norm) {
    const forms = [{ norm, note: null }];
    const stripped = stripDistrictSuffix(norm);
    if (stripped) forms.push({ norm: stripped, note: "district suffix stripped" });

    for (const { norm: form, note } of forms) {
      // Tier 1: exact identifier (any scheme; collisions like postal MA vs iso2 MA expected)
      for (const [scheme, entityIdx] of index.identifiers[form] ?? []) {
        consider(entityIdx, TIER_IDENTIFIER, { tier: "identifier", scheme, matched: form, note });
      }
      // Tier 2: exact normalized name
      const rowIdx = findNameRow(index, form);
      if (rowIdx >= 0) {
        for (const [entityIdx, nameType, source] of index.names[rowIdx][1]) {
          consider(entityIdx, TIER_EXACT_NAME, { tier: "exact_name", matched: form, nameType, source, note });
        }
      }
      // Tier 3: trigram fuzzy (identical norms are tier 2's job — skipping them
      // keeps a perfect trigram match from outranking the exact-name tier)
      for (const [nameIdx, sim] of fuzzyCandidates(index, form)) {
        const [candNorm, postings] = index.names[nameIdx];
        if (candNorm === form) continue;
        for (const [entityIdx, nameType, source] of postings) {
          consider(entityIdx, sim, {
            tier: "fuzzy_name", matched: candNorm, similarity: Math.round(sim * 1000) / 1000,
            nameType, source, note,
          });
        }
      }
    }
  }
  return { norm, candidates: [...byEntity.values()] };
}

// ------------------------------------------------------------ scoring passes

function applyContext(index, cand, context) {
  const e = index.entities[cand.entityIdx];
  let score = cand.base * (LAYER_PRIOR[e.layer] ?? 1);
  const factors = [];
  if (context.layer && e.layer !== context.layer) {
    score *= CTX_LAYER_MISMATCH;
    factors.push("context_layer_mismatch");
  }
  if (context.country && e.country !== context.country) {
    score *= CTX_COUNTRY_MISMATCH;
    factors.push("context_country_mismatch");
  }
  if (context.parent && e.parent !== context.parent) {
    score *= CTX_PARENT_MISMATCH;
    factors.push("context_parent_mismatch");
  }
  // "Autauga County" literally says district — reward district candidates
  // matched via the stripped form (the same stripped form also matches
  // same-named states, which must not win here).
  if (cand.explanation?.note && e.layer === "districts") {
    score *= DISTRICT_SUFFIX_BONUS;
    factors.push("district_suffix_bonus");
  }
  return { ...cand, score, factors };
}

const byScoreThenGid = (index) => (a, b) =>
  b.score - a.score || (index.entities[a.entityIdx].gid < index.entities[b.entityIdx].gid ? -1 : 1);

// Dominant (layer, country) across keys that resolved cleanly pre-consensus.
// If strict anchors (clear margin) are too few — common because many US state
// names are also county names — fall back to soft anchors: any key whose top
// candidate is strictly ordered, if only by the prominence prior.
function computeConsensus(index, perKey) {
  const anchorsWith = (minMargin) =>
    perKey.filter((k) => {
      if (k.candidates.length === 0) return false;
      const top = k.candidates[0];
      const second = k.candidates[1];
      return top.score >= RESOLVED_MIN && (!second || top.score - second.score >= minMargin);
    });

  let anchors = anchorsWith(MARGIN);
  if (anchors.length < CONSENSUS_MIN_BATCH) anchors = anchorsWith(0.001);
  if (anchors.length < CONSENSUS_MIN_BATCH) return null;

  const tally = (pick) => {
    const counts = new Map();
    for (const a of anchors) {
      const v = pick(index.entities[a.candidates[0].entityIdx]);
      if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const top = sorted[0];
    return top && top[1] / anchors.length > CONSENSUS_DOMINANCE ? top[0] : null;
  };

  const layer = tally((e) => e.layer);
  const country = tally((e) => e.country);
  return layer || country ? { layer, country, anchorCount: anchors.length } : null;
}

function applyConsensus(index, cand, consensus) {
  const e = index.entities[cand.entityIdx];
  let score = cand.score;
  const factors = [...cand.factors];
  if (consensus.layer) {
    score *= e.layer === consensus.layer ? CONS_LAYER_MATCH : CONS_LAYER_MISMATCH;
    factors.push(e.layer === consensus.layer ? "consensus_layer_match" : "consensus_layer_mismatch");
  }
  if (consensus.country) {
    score *= e.country === consensus.country ? CONS_COUNTRY_MATCH : CONS_COUNTRY_MISMATCH;
    factors.push(e.country === consensus.country ? "consensus_country_match" : "consensus_country_mismatch");
  }
  // No cap here: ranking and margin checks use raw scores so a consensus boost
  // isn't compressed against the cap (Florida vs Uruguay's Florida department).
  // Only the reported confidence is capped, in decide().
  return { ...cand, score, factors };
}

// ----------------------------------------------------------------- results

function entityPayload(index, entityIdx) {
  const e = index.entities[entityIdx];
  const crosswalk = {};
  for (const k of ["iso2", "iso3", "isoNum", "fips", "fipsState", "postal", "zcta"]) {
    if (e[k] != null) crosswalk[k] = e[k];
  }
  // gid is always the geo API join key. For namespaced entities (postal),
  // that's geoKey; entityId then carries the internal id for /v1/entities lookups.
  const payload = { gid: e.geoKey ?? e.gid, name: e.name, layer: e.layer, parent: e.parent, crosswalk };
  if (e.geoKey) payload.entityId = e.gid;
  return payload;
}

function decide(index, key, norm, candidates) {
  if (candidates.length === 0) {
    return { key, status: "miss", confidence: 0, explanation: { normalized: norm } };
  }
  const top = candidates[0];
  const second = candidates[1];
  const confidence = Math.round(Math.min(top.score, SCORE_CAP) * 1000) / 1000;
  const explanation = { normalized: norm, ...top.explanation, factors: top.factors };
  const base = { key, confidence, explanation, ...entityPayload(index, top.entityIdx) };

  if (top.score < RESOLVED_MIN) {
    return { ...base, status: "low_confidence", candidates: shortlist(index, candidates) };
  }
  if (second && top.score - second.score < MARGIN) {
    return { ...base, status: "ambiguous", candidates: shortlist(index, candidates) };
  }
  return { ...base, status: "resolved" };
}

function shortlist(index, candidates) {
  return candidates.slice(0, 3).map((c) => ({
    ...entityPayload(index, c.entityIdx),
    confidence: Math.round(Math.min(c.score, SCORE_CAP) * 1000) / 1000,
  }));
}

// -------------------------------------------------------------------- main

export function resolveBatch(index, keys, context = {}) {
  const cmp = byScoreThenGid(index);

  const perKey = keys.map((key) => {
    const { norm, candidates } = candidatesForKey(index, key);
    const scored = candidates.map((c) => applyContext(index, c, context)).sort(cmp);
    return { key, norm, candidates: scored };
  });

  const consensus = keys.length >= CONSENSUS_MIN_BATCH ? computeConsensus(index, perKey) : null;
  if (consensus) {
    for (const k of perKey) {
      k.candidates = k.candidates.map((c) => applyConsensus(index, c, consensus)).sort(cmp);
    }
  }

  return {
    consensus,
    results: perKey.map((k) => decide(index, k.key, k.norm, k.candidates)),
  };
}
