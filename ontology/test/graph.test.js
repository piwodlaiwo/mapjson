import { describe, it, expect } from "vitest";
import { buildGraph } from "../src/graph.js";
import index from "../src/generated/hot.json";

const nodeIds = (g) => g.elements.nodes.map((n) => n.data.id);

describe("buildGraph", () => {
  it("returns null for unknown gid", () => {
    expect(buildGraph(index, "NOPE")).toBeNull();
  });

  it("US-MA graph has ancestor US, its counties, and code leaves", () => {
    const g = buildGraph(index, "US-MA", 1);
    const ids = nodeIds(g);
    expect(ids).toContain("US");
    expect(ids).toContain("25025"); // Suffolk County MA
    expect(ids).toContain("name:massachusetts");
    expect(ids).toContain("name:mass");
    expect(ids).toContain("ident:ma");
    expect(g.elements.edges.some((e) => e.data.type === "contains" && e.data.source === "US")).toBe(true);
  });

  it("identifier collision surfaces co-claimants (postal MA vs iso2 Morocco)", () => {
    const g = buildGraph(index, "US-MA", 1);
    expect(nodeIds(g)).toContain("MA"); // Morocco pulled in via shared "ma" code
    const morocco = g.elements.nodes.find((n) => n.data.id === "MA");
    expect(morocco.data.role).toBe("co-claimant");
    expect(g.elements.edges.some((e) => e.data.id.startsWith("i:ma:") && e.data.type === "code_shared")).toBe(true);
  });

  it("shared names surface co-claimants (Georgia country vs state)", () => {
    const g = buildGraph(index, "GE", 1);
    expect(nodeIds(g)).toContain("US-GA");
    const alias = g.elements.nodes.find((n) => n.data.id === "name:georgia");
    expect(alias.data.shared).toBe(true);
  });

  it("caps node count and flags truncation at depth 2 on US", () => {
    const g = buildGraph(index, "US", 2);
    expect(g.truncated).toBe(true);
    expect(g.elements.nodes.length).toBeLessThan(450);
  });

  it("is deterministic", () => {
    expect(buildGraph(index, "DE-BY", 1)).toEqual(buildGraph(index, "DE-BY", 1));
  });
});
