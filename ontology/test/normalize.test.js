import { describe, it, expect } from "vitest";
import { normalize, stripDistrictSuffix } from "../src/lib/normalize.js";

describe("normalize", () => {
  it("lowercases, trims, collapses whitespace", () => {
    expect(normalize("  New   York ")).toBe("new york");
  });
  it("folds diacritics and special letters", () => {
    expect(normalize("München")).toBe("munchen");
    expect(normalize("Baden-Württemberg")).toBe("baden wurttemberg");
    expect(normalize("Łódź")).toBe("lodz");
    expect(normalize("Großenhain")).toBe("grossenhain");
    expect(normalize("Curaçao")).toBe("curacao");
  });
  it("drops apostrophes without splitting the word", () => {
    expect(normalize("Cote d'Ivoire")).toBe("cote divoire");
    expect(normalize("Hawai’i")).toBe("hawaii");
  });
  it("collapses dotted initialisms", () => {
    expect(normalize("U.S.A.")).toBe("usa");
    expect(normalize("D.C.")).toBe("dc");
    expect(normalize("N.Y.")).toBe("ny");
    expect(normalize("W.Va.")).toBe("w va");
  });
  it("expands st. to saint", () => {
    expect(normalize("St. Louis")).toBe("saint louis");
  });
  it("is idempotent", () => {
    const once = normalize("Frankfurt a.M.");
    expect(normalize(once)).toBe(once);
  });
});

describe("stripDistrictSuffix", () => {
  it("strips county/parish/borough", () => {
    expect(stripDistrictSuffix("autauga county")).toBe("autauga");
    expect(stripDistrictSuffix("east baton rouge parish")).toBe("east baton rouge");
  });
  it("returns null when nothing to strip", () => {
    expect(stripDistrictSuffix("autauga")).toBeNull();
  });
});
