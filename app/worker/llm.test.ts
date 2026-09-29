import { describe, expect, it } from "vitest";
import {
  AttemptError,
  circuitKey,
  classifyGatewayResponse,
  classifyThrown,
  parseChatStream,
  providerOf,
} from "./llm.js";

function sse(...parts: string[]): ReadableStream {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream, signal = new AbortController().signal): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of parseChatStream(stream, signal)) out.push(chunk);
  return out;
}

describe("classifyGatewayResponse", () => {
  it.each([
    [402, "", "out of credits", true, false],
    [400, '{"error":[{"code":2021}]}', "out of credits", true, false],
    [401, "", "provider key missing or invalid", true, false],
    [403, "", "provider key missing or invalid", true, false],
    [429, "", "rate limited", false, true],
    [400, "bad model", "provider rejected the request", false, false],
    [503, "", "provider unavailable", false, true],
  ])("%i %s -> %s", (status, body, reason, providerLevel, retryable) => {
    const err = classifyGatewayResponse(status, body);
    expect(err).toMatchObject({ reason, providerLevel, retryable });
    expect(err.detail).toContain(String(status));
  });
});

describe("classifyThrown", () => {
  it.each([
    ["2021: Insufficient AI Gateway credits", "out of credits", true, false],
    ["3036: daily free allocation used", "daily Workers AI limit reached", true, false],
    ["5035: Model is not available on the Workers Free plan", "not available on your plan", false, false],
    ["7003: User Input Error", "provider unavailable", false, true],
    ["3040: Capacity temporarily exceeded", "model at capacity", false, true],
    ["network connection lost", "provider unavailable", false, true],
  ])("%s", (message, reason, providerLevel, retryable) => {
    expect(classifyThrown(new Error(message))).toMatchObject({ reason, providerLevel, retryable });
  });

  it("handles non-Error throws", () => {
    expect(classifyThrown("boom").reason).toBe("provider unavailable");
  });
});

describe("providerOf / circuitKey", () => {
  it("returns the id prefix", () => {
    expect(providerOf("anthropic/claude-haiku-4-5")).toBe("anthropic");
    expect(providerOf("@cf/meta/llama-3.3-70b-instruct-fp8-fast")).toBe("@cf");
  });

  it("scopes plan-gated failures to the model, credit failures to the provider", () => {
    expect(circuitKey("@cf/zai-org/glm-5.3", classifyThrown(new Error("5035: not on plan")))).toBe(
      "model:@cf/zai-org/glm-5.3"
    );
    expect(circuitKey("anthropic/claude-haiku-4-5", classifyGatewayResponse(402, ""))).toBe("anthropic");
  });
});

describe("parseChatStream", () => {
  it("reads OpenAI-format deltas", async () => {
    const stream = sse(
      'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      "data: [DONE]\n\n"
    );
    expect(await collect(stream)).toEqual(["Hel", "lo"]);
  });

  it("reads legacy Workers AI chunks", async () => {
    expect(await collect(sse('data: {"response":"Hi"}\n\n', "data: [DONE]\n\n"))).toEqual(["Hi"]);
  });

  it("prefers choices when a chunk carries both shapes", async () => {
    const stream = sse('data: {"response":"Hi","choices":[{"delta":{"content":"Hi"}}]}\n\n');
    expect(await collect(stream)).toEqual(["Hi"]);
  });

  it("ignores reasoning-only deltas", async () => {
    const stream = sse('data: {"choices":[{"delta":{"reasoning":"thinking..."}}]}\n\n');
    expect(await collect(stream)).toEqual([]);
  });

  it("reassembles a line split across reads", async () => {
    const stream = sse('data: {"choices":[{"delta":{"con', 'tent":"split"}}]}\n\n');
    expect(await collect(stream)).toEqual(["split"]);
  });

  it("skips malformed chunks and stops at [DONE]", async () => {
    const stream = sse("data: {not json\n\n", 'data: {"response":"ok"}\n\n', "data: [DONE]\n\n", 'data: {"response":"late"}\n\n');
    expect(await collect(stream)).toEqual(["ok"]);
  });

  it("throws a retryable AttemptError on an error chunk", async () => {
    const stream = sse('data: {"response":"a"}\n\n', 'data: {"error":{"message":"overloaded"}}\n\n');
    const err = await collect(stream).catch((e) => e);
    expect(err).toBeInstanceOf(AttemptError);
    expect(err).toMatchObject({ reason: "provider error mid-stream", retryable: true });
  });

  it("stops when aborted", async () => {
    const abort = new AbortController();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"response":"a"}\n\n'));
      },
    });
    const received: string[] = [];
    const run = (async () => {
      for await (const chunk of parseChatStream(stream, abort.signal)) {
        received.push(chunk);
        abort.abort();
      }
    })();
    await expect(run).rejects.toThrow("aborted");
    expect(received).toEqual(["a"]);
  });
});
