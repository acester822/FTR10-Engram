import { describe, it, expect } from "vitest";
import { normalizeSector, VALID_SECTORS } from "../src/services/memoryInjector";

describe("normalizeSector", () => {
  it("accepts the five canonical sectors exactly", () => {
    for (const s of VALID_SECTORS) {
      expect(normalizeSector(s)).toBe(s);
      // case-insensitive
      expect(normalizeSector(s.toUpperCase())).toBe(s);
      expect(normalizeSector(`  ${s}  `)).toBe(s);
    }
  });

  it("coerces invalid sectors such as 'important decision' to a default", () => {
    expect(normalizeSector("important decision")).toBe("semantic");
    expect(normalizeSector("project")).toBe("semantic");
    expect(normalizeSector("rule")).toBe("semantic");
  });

  it("extracts a known sector embedded in a longer string", () => {
    expect(normalizeSector("procedural step for auth")).toBe("procedural");
    expect(normalizeSector("emotional: user was frustrated")).toBe("emotional");
  });

  it("falls back to the provided fallback for non-strings and empty input", () => {
    expect(normalizeSector(undefined)).toBe("semantic");
    expect(normalizeSector(null)).toBe("semantic");
    expect(normalizeSector("")).toBe("semantic");
    expect(normalizeSector("   ")).toBe("semantic");
    expect(normalizeSector("nonsense", "reflective")).toBe("reflective");
    expect(normalizeSector(undefined, "episodic")).toBe("episodic");
  });
});
