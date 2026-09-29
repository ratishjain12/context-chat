export class AttemptError extends Error {
  readonly reason: string;
  // Whole provider unusable (no credits, bad key) -- opens its circuit.
  readonly providerLevel: boolean;
  // This model is unusable on this account (plan-gated) -- opens its own circuit.
  readonly modelLevel: boolean;
  // Likely to succeed on an immediate retry of the same model (429, 5xx).
  readonly retryable: boolean;
  readonly detail?: string;

  constructor(
    reason: string,
    opts: { providerLevel?: boolean; modelLevel?: boolean; retryable?: boolean; detail?: string } = {}
  ) {
    super(reason);
    this.reason = reason;
    this.providerLevel = opts.providerLevel ?? false;
    this.modelLevel = opts.modelLevel ?? false;
    this.retryable = opts.retryable ?? false;
    this.detail = opts.detail;
  }
}

// "openai" / "anthropic" / "google-ai-studio" / "@cf"
export function providerOf(model: string): string {
  return model.split("/")[0];
}

// Circuit-breaker key for the scope a failure applies to.
export function circuitKey(model: string, failure?: AttemptError): string {
  return failure?.modelLevel ? `model:${model}` : providerOf(model);
}

// Compat endpoint failures, as observed: 402 (+ code 2021) = no BYOK key and
// no Unified Billing credits; 401 = key missing/invalid (also what a bogus
// Anthropic id returns); 400 = bad id or params.
export function classifyGatewayResponse(status: number, body: string): AttemptError {
  const detail = `${status} ${body.slice(0, 500)}`;
  if (status === 402 || body.includes('"code":2021')) {
    return new AttemptError("out of credits", { providerLevel: true, detail });
  }
  if (status === 401 || status === 403) {
    return new AttemptError("provider key missing or invalid", { providerLevel: true, detail });
  }
  if (status === 429) {
    return new AttemptError("rate limited", { retryable: true, detail });
  }
  if (status >= 400 && status < 500) {
    return new AttemptError("provider rejected the request", { detail });
  }
  return new AttemptError("provider unavailable", { retryable: true, detail });
}

// env.AI.run throws Error("<4-digit code>: <message>").
export function classifyThrown(err: unknown): AttemptError {
  const message = err instanceof Error ? err.message : String(err);
  const detail = err instanceof Error ? `${err.name}: ${message}` : message;
  switch (/^(\d{4})\b/.exec(message)?.[1]) {
    case "2021":
      return new AttemptError("out of credits", { providerLevel: true, detail });
    case "3036":
      return new AttemptError("daily Workers AI limit reached", { providerLevel: true, detail });
    case "5035":
      return new AttemptError("not available on your plan", { modelLevel: true, detail });
    case "3040":
      return new AttemptError("model at capacity", { retryable: true, detail });
    default:
      return new AttemptError("provider unavailable", { retryable: true, detail });
  }
}

// env.AI.run takes no AbortSignal, so a hung call can only be abandoned.
export function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    promise.then(resolve, reject);
  });
}

// Two chunk shapes arrive: OpenAI `choices[0].delta.content` (compat, and
// Workers AI models like gpt-oss) and legacy Workers AI `{response}`
// (llama-3.2-11b-vision). llama-3.3 sends both in one chunk, so `choices`
// wins when present -- reading both doubles the text.
export async function* parseChatStream(
  stream: ReadableStream,
  signal: AbortSignal
): AsyncGenerator<string> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  const onAbort = () => reader.cancel().catch(() => {});
  signal.addEventListener("abort", onAbort, { once: true });
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) {
        throw new Error("aborted");
      }
      if (done) {
        return;
      }

      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) {
          continue;
        }
        const data = trimmed.slice("data:".length).trim();
        if (data === "[DONE]") {
          return;
        }
        let parsed: {
          response?: string;
          choices?: { delta?: { content?: string | null } }[];
          error?: unknown;
        };
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        if (parsed.error) {
          throw new AttemptError("provider error mid-stream", {
            retryable: true,
            detail: JSON.stringify(parsed.error).slice(0, 500),
          });
        }
        const text = parsed.choices ? parsed.choices[0]?.delta?.content : parsed.response;
        if (text) {
          yield text;
        }
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
