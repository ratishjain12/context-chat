// Workers AI models only for now -- all reachable via env.AI.run() with zero
// extra API keys. Adding OpenAI/Anthropic/Gemini later means adding entries
// here that route through fetch() to their AI Gateway provider endpoint
// instead of env.AI.run(), once a provider key exists as a secret.
// Mirrors src/lib/models.ts (frontend UX copy) -- keep both in sync.
export interface ModelOption {
  id: string;
  label: string;
  description: string;
}

export const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export const MODELS: ModelOption[] = [
  { id: "@cf/meta/llama-3.2-3b-instruct", label: "Fast", description: "Quick, low-cost, 80K context" },
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Balanced", description: "Default -- good quality, 24K context" },
  { id: "@cf/openai/gpt-oss-120b", label: "Powerful", description: "Strongest reasoning, 128K context" },
];

// None of the text models above accept image input -- a message with image
// attachments is always routed to this one instead, regardless of the
// user's dropdown selection (a text model literally cannot see an image;
// silently ignoring the selection here is the lesser surprise than the
// model hallucinating about an image it never received).
export const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

export function isValidModel(id: string): boolean {
  return MODELS.some((m) => m.id === id);
}
