// Acceptance suite from the design docs, run against the real built index
// (src/generated/hot.json — `npm run build-index` first).

import { describe, it, expect } from "vitest";
import { resolveBatch } from "../src/resolver.js";
import index from "../src/generated/hot.json";

const US_STATES_BATCH = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado",
  "Connecticut", "Delaware", "Florida", "Georgia", "Massachusetts",
  "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana",
];
const COUNTRY_BATCH = ["France", "Germany", "Spain", "Italy", "Poland", "Japan", "Georgia"];

const resultFor = (out, key) => out.results.find((r) => r.key === key);

describe("the Georgia problem", () => {
  it("resolves Georgia to US-GA in a batch of US states", () => {
    const out = resolveBatch(index, US_STATES_BATCH);
    const georgia = resultFor(out, "Georgia");
    expect(georgia.status).toBe("resolved");
    expect(georgia.gid).toBe("US-GA");
    expect(georgia.explanation.factors).toContain("consensus_layer_match");
  });

  it("resolves Georgia to the country GE in a batch of countries", () => {
    const out = resolveBatch(index, COUNTRY_BATCH);
    const georgia = resultFor(out, "Georgia");
    expect(georgia.status).toBe("resolved");
    expect(georgia.gid).toBe("GE");
  });
});

describe("MA disambiguation", () => {
  it("MA in a US-states batch is Massachusetts", () => {
    const out = resolveBatch(index, [...US_STATES_BATCH, "MA"]);
    const ma = resultFor(out, "MA");
    expect(ma.status).toBe("resolved");
    expect(ma.gid).toBe("US-MA");
  });

  it("MA alone is ambiguous between Massachusetts and Morocco", () => {
    const out = resolveBatch(index, ["MA"]);
    const ma = out.results[0];
    expect(ma.status).toBe("ambiguous");
    const gids = ma.candidates.map((c) => c.gid);
    expect(gids).toContain("US-MA");
    expect(gids).toContain("MA");
  });

  it("MA with context layer=countries is Morocco", () => {
    const out = resolveBatch(index, ["MA"], { layer: "countries" });
    expect(out.results[0].status).toBe("resolved");
    expect(out.results[0].gid).toBe("MA");
  });
});

describe("aliases and fuzzy matching", () => {
  it("Mass resolves to US-MA via curated alias", () => {
    const out = resolveBatch(index, ["Mass"]);
    expect(out.results[0].gid).toBe("US-MA");
    expect(out.results[0].status).toBe("resolved");
    expect(out.results[0].explanation.tier).toBe("exact_name");
  });

  it("the typo Massachusets reaches US-MA via trigram", () => {
    const out = resolveBatch(index, ["Massachusets"]);
    const r = out.results[0];
    expect(r.gid).toBe("US-MA");
    expect(["resolved", "low_confidence"]).toContain(r.status);
    expect(r.explanation.tier).toBe("fuzzy_name");
  });

  it("USA and U.S. resolve to the US", () => {
    const out = resolveBatch(index, ["USA", "U.S."]);
    expect(out.results.map((r) => r.gid)).toEqual(["US", "US"]);
  });

  it("Bavaria (curated exonym) resolves to DE-BY", () => {
    const out = resolveBatch(index, ["Bavaria"]);
    expect(out.results[0].gid).toBe("DE-BY");
  });
});

describe("identifier schemes", () => {
  it("state FIPS codes resolve via batch consensus (36 = NY, not Australia isoNum)", () => {
    const out = resolveBatch(index, ["25", "06", "36", "48", "12", "01", "02", "05"]);
    expect(resultFor(out, "25").gid).toBe("US-MA");
    expect(resultFor(out, "36").gid).toBe("US-NY");
    expect(resultFor(out, "48").gid).toBe("US-TX");
  });

  it("county FIPS resolves directly", () => {
    const out = resolveBatch(index, ["01001", "53073"]);
    expect(out.results[0].gid).toBe("01001");
    expect(out.results[0].name).toBe("Autauga");
    expect(out.results[1].gid).toBe("53073");
  });

  it("ISO 3166-2 codes resolve", () => {
    const out = resolveBatch(index, ["US-MA", "DE-BY", "PL-DS"]);
    expect(out.results.map((r) => r.gid)).toEqual(["US-MA", "DE-BY", "PL-DS"]);
  });
});

describe("district suffix handling", () => {
  it("Autauga County resolves with the suffix stripped", () => {
    const out = resolveBatch(index, ["Autauga County"], { layer: "districts" });
    expect(out.results[0].gid).toBe("01001");
    expect(out.results[0].explanation.note).toBe("district suffix stripped");
  });

  it("state-named counties resolve to counties, not states", () => {
    // "Texas County" must not resolve to the state of Texas
    const out = resolveBatch(index, ["Texas County", "Nevada County", "Iowa County"], {
      country: "US",
    });
    for (const r of out.results) {
      expect(r.layer, `${r.key} resolved to ${r.gid}`).toBe("districts");
    }
  });
});

describe("small batches and prominence", () => {
  it("consensus works on a small colliding batch via soft anchors", () => {
    // Most of these state names are also county names — strict anchors are scarce
    const out = resolveBatch(index, [
      "Alabama", "California", "Texas", "Florida", "Georgia", "Nevada", "Ohio", "Utah",
    ]);
    expect(out.consensus).not.toBeNull();
    for (const r of out.results) {
      expect(r.status, `${r.key} → ${r.gid} (${r.status})`).toBe("resolved");
      expect(r.layer).toBe("regions");
    }
  });

  it("a bare ambiguous key still ranks the prominent entity first", () => {
    const out = resolveBatch(index, ["Georgia"]);
    expect(out.results[0].status).toBe("ambiguous");
    expect(out.results[0].gid).toBe("GE"); // country outranks US state absent all context
  });
});

describe("statuses and shape", () => {
  it("garbage keys miss", () => {
    const out = resolveBatch(index, ["zzzzqqqxx"]);
    expect(out.results[0].status).toBe("miss");
    expect(out.results[0].confidence).toBe(0);
  });

  it("results carry the identifier crosswalk", () => {
    const out = resolveBatch(index, ["Massachusetts"]);
    const r = out.results[0];
    expect(r.crosswalk.postal).toBe("MA");
    expect(r.crosswalk.fipsState).toBe("25");
  });

  it("every result has an explanation with normalized form", () => {
    const out = resolveBatch(index, ["Mass", "zzzzqqqxx"]);
    for (const r of out.results) expect(r.explanation.normalized).toBeDefined();
  });
});

describe("postal (ZCTA) resolution", () => {
  it("a unique ZIP resolves with the bare code as gid and a namespaced entityId", () => {
    const out = resolveBatch(index, ["02139"]);
    const r = out.results[0];
    expect(r.status).toBe("resolved");
    expect(r.gid).toBe("02139");           // join key for the geo API
    expect(r.entityId).toBe("US-02139");   // internal ontology id
    expect(r.layer).toBe("postal");
    expect(r.parent).toBe("US-MA");
    expect(r.crosswalk.zcta).toBe("02139");
  });

  it("01001 (county FIPS vs ZIP collision) follows batch consensus", () => {
    const zips = resolveBatch(index, ["02139", "90210", "10001", "60601", "01001"]);
    const inZips = zips.results.find((r) => r.key === "01001");
    expect(inZips.layer).toBe("postal");
    expect(inZips.parent).toBe("US-MA"); // Agawam MA, not Autauga County AL

    const counties = resolveBatch(index, ["01001"], { layer: "districts" });
    expect(counties.results[0].gid).toBe("01001");
    expect(counties.results[0].layer).toBe("districts");
    expect(counties.results[0].name).toBe("Autauga");
  });

  it("spreadsheet-mangled ZIPs (leading zero stripped) still resolve", () => {
    const out = resolveBatch(index, ["2139"], { layer: "postal" });
    expect(out.results[0].gid).toBe("02139");
  });
});

describe("determinism", () => {
  it("same input produces identical output", () => {
    const a = resolveBatch(index, [...US_STATES_BATCH, "MA", "Massachusets"]);
    const b = resolveBatch(index, [...US_STATES_BATCH, "MA", "Massachusets"]);
    expect(a).toEqual(b);
  });
});
