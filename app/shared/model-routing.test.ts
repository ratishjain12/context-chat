import { describe, expect, it } from "vitest";
import { findModel, isWorkersAIModel } from "./models.js";
import { rankAlternatives, resolveModel } from "./model-routing.js";

const LLAMA_TEXT = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const SONNET = "anthropic/claude-sonnet-4-6";
const GPT_MINI = "openai/gpt-4.1-mini";

describe("resolveModel", () => {
  it("keeps the pick when it meets the needs", () => {
    expect(resolveModel(LLAMA_TEXT, { vision: false })).toBe(LLAMA_TEXT);
    expect(resolveModel(GPT_MINI, { vision: true })).toBe(GPT_MINI);
  });

  it("swaps a text-only pick for a Workers AI vision model when an image is attached", () => {
    const resolved = resolveModel(LLAMA_TEXT, { vision: true });
    expect(resolved).not.toBe(LLAMA_TEXT);
    expect(findModel(resolved)?.vision).toBe(true);
    expect(isWorkersAIModel(resolved)).toBe(true);
  });
});

describe("rankAlternatives", () => {
  it("never includes the requested model", () => {
    expect(rankAlternatives(SONNET, { vision: false }).map((m) => m.id)).not.toContain(SONNET);
  });

  it("keeps a Workers AI pick on Workers AI", () => {
    const ranked = rankAlternatives(LLAMA_TEXT, { vision: false });
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.every((m) => isWorkersAIModel(m.id))).toBe(true);
  });

  it("lets an external pick fall back to other providers and Workers AI", () => {
    const ranked = rankAlternatives(SONNET, { vision: false });
    expect(ranked.some((m) => m.provider !== "Anthropic" && !isWorkersAIModel(m.id))).toBe(true);
    expect(ranked.some((m) => isWorkersAIModel(m.id))).toBe(true);
  });

  it("only returns vision models when an image is attached", () => {
    expect(rankAlternatives(GPT_MINI, { vision: true }).every((m) => m.vision)).toBe(true);
  });

  it("ranks the same provider first", () => {
    expect(rankAlternatives(SONNET, { vision: false })[0].id).toBe("anthropic/claude-haiku-4-5");
  });

  it("orders other models by price distance from the pick", () => {
    const requested = findModel(SONNET)!;
    const price = (id: string) => {
      const m = findModel(id)!;
      return Math.abs(Math.log(m.pricePerMInput! + m.pricePerMOutput!) - Math.log(requested.pricePerMInput! + requested.pricePerMOutput!));
    };
    const others = rankAlternatives(SONNET, { vision: false })
      .filter((m) => m.provider !== requested.provider && m.pricePerMInput != null && m.pricePerMOutput != null)
      .map((m) => price(m.id));
    expect(others).toEqual([...others].sort((a, b) => a - b));
  });
});
