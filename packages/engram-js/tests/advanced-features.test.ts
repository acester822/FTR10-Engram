import { describe, it, expect } from "vitest";
import {
  ImportanceCalculator,
  TIER_CONFIG,
} from "../src/services/importanceCalculator";
import {
  createWindows,
  tokenize,
  MAX_WINDOWS,
  STRIDE,
} from "../src/services/windowedEmbedder";
import {
  fuseEvidence,
  importanceMultiplier,
  hybridRecallScore,
  vectorProbability,
  lexicalProbability,
} from "../src/durable/scoring";

describe("ImportanceCalculator", () => {
  const calc = new ImportanceCalculator();

  it("assigns critical tier to explicit remember requests", () => {
    const result = calc.calculate("Remember this: always use TypeScript");
    expect(result.tier).toBe("critical");
    expect(result.score).toBe(0.9);
    expect(result.decay_rate).toBe(TIER_CONFIG.critical.decay_rate);
  });

  it("assigns high tier to preferences and decisions", () => {
    expect(calc.calculate("I prefer Python for data work").tier).toBe("high");
    expect(calc.calculate("We decided to use Postgres").tier).toBe("high");
  });

  it("assigns high tier to semantic/procedural sectors via metadata", () => {
    expect(calc.calculate("deploy the stack", { sector: "procedural" }).tier).toBe("high");
    expect(calc.calculate("the API listens on 8098", { sector: "semantic" }).tier).toBe("high");
  });

  it("assigns low tier to transient content", () => {
    expect(calc.calculate("This is just temporary for today").tier).toBe("low");
    expect(calc.calculate("I worked on it this week", { sector: "episodic" }).tier).toBe("low");
  });

  it("defaults to medium", () => {
    const result = calc.calculate("The Eiffel Tower is in Paris");
    expect(result.tier).toBe("medium");
    expect(result.score).toBe(0.5);
  });

  it("critical overrides sector hints", () => {
    const result = calc.calculate("Important: always back up the database", {
      sector: "episodic",
    });
    expect(result.tier).toBe("critical");
  });
});

describe("Evidence fusion (scoring.ts)", () => {
  it("returns 0 when both signals are absent", () => {
    expect(fuseEvidence(0, 0)).toBe(0);
  });

  it("fuses vector and lexical evidence (probabilistic OR)", () => {
    // Inputs are raw similarity scores; fuseEvidence calibrates them first
    // (vectorProbability / lexicalProbability), then ORs the probabilities.
    const fused = fuseEvidence(0.6, 0.5);
    const expected =
      1 - (1 - vectorProbability(0.6)) * (1 - lexicalProbability(0.5));
    expect(fused).toBeCloseTo(expected);
    expect(fused).toBeGreaterThan(vectorProbability(0.6));
    expect(fused).toBeGreaterThan(lexicalProbability(0.5));
  });

  it("clamps vector probability into [0, 0.88]", () => {
    expect(vectorProbability(0.95)).toBeLessThanOrEqual(0.88);
    expect(vectorProbability(-1)).toBe(0);
  });

  it("caps lexical probability at 0.95", () => {
    expect(lexicalProbability(1)).toBe(0.95);
    expect(lexicalProbability(0.3)).toBeCloseTo(0.6);
  });

  it("is neutral at the default importance score of 0.5", () => {
    expect(importanceMultiplier(0.5)).toBe(1);
  });

  it("boosts critical and penalizes low importance", () => {
    expect(importanceMultiplier(0.9)).toBeGreaterThan(1);
    expect(importanceMultiplier(0.25)).toBeLessThan(1);
  });

  it("boosts memories with both vector and lexical evidence", () => {
    const both = hybridRecallScore({
      vectorDistance: 0.1,
      lexicalScore: 0.8,
      importanceScore: 0.5,
    });
    const vectorOnly = hybridRecallScore({
      vectorDistance: 0.1,
      lexicalScore: 0,
      importanceScore: 0.5,
    });
    const keywordOnly = hybridRecallScore({
      vectorDistance: null,
      lexicalScore: 0.8,
      importanceScore: 0.5,
    });
    expect(both).toBeGreaterThan(vectorOnly);
    expect(both).toBeGreaterThan(keywordOnly);
  });

  it("applies contradiction and contract penalties", () => {
    const clean = hybridRecallScore({
      vectorDistance: 0.1,
      lexicalScore: 0.5,
      importanceScore: 0.5,
    });
    const contradicted = hybridRecallScore({
      vectorDistance: 0.1,
      lexicalScore: 0.5,
      importanceScore: 0.5,
      contradictionPenalty: 0.35,
    });
    const blocked = hybridRecallScore({
      vectorDistance: 0.1,
      lexicalScore: 0.5,
      importanceScore: 0.5,
      contractPenalty: 1,
    });
    expect(contradicted).toBeLessThan(clean);
    expect(blocked).toBe(0);
  });
});

describe("WindowedEmbedder windowing", () => {
  it("creates overlapping windows for long content", () => {
    const tokens = tokenize("word ".repeat(1000).trim());
    const windows = createWindows(tokens);
    expect(windows.length).toBeGreaterThan(1);
    // Overlap = WINDOW_SIZE - STRIDE; second window starts at STRIDE.
    expect(windows[1].start_pos).toBe(STRIDE);
    // Windows are ordered and non-empty.
    for (const w of windows) {
      expect(w.end_pos).toBeGreaterThan(w.start_pos);
    }
  });

  it("creates a single window for short content", () => {
    const windows = createWindows(tokenize("short content here"));
    expect(windows).toHaveLength(1);
    expect(windows[0].start_pos).toBe(0);
  });

  it("caps window count at MAX_WINDOWS", () => {
    const tokens = tokenize("word ".repeat(50000).trim());
    const windows = createWindows(tokens);
    expect(windows.length).toBeLessThanOrEqual(MAX_WINDOWS);
  });

  it("tokenizes on whitespace and drops empties", () => {
    expect(tokenize("  a  b \t c ")).toEqual(["a", "b", "c"]);
  });
});
