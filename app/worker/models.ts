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

export function isValidModel(id: string): boolean {
  return MODELS.some((m) => m.id === id);
}
