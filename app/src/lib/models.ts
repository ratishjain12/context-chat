// Mirrors worker/models.ts -- keep both in sync.
export interface ModelOption {
  id: string
  label: string
  description: string
}

export const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"

export const MODELS: ModelOption[] = [
  { id: "@cf/meta/llama-3.2-3b-instruct", label: "Fast", description: "Quick, low-cost, 80K context" },
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Balanced", description: "Default -- good quality, 24K context" },
  { id: "@cf/openai/gpt-oss-120b", label: "Powerful", description: "Strongest reasoning, 128K context" },
]

// Not user-selectable in the dropdown -- the backend routes image messages
// here automatically regardless of the selected model. Included only so the
// message badge can show a real label instead of the raw model id.
export const VISION_MODEL = { id: "@cf/meta/llama-3.2-11b-vision-instruct", label: "Vision", description: "Handles image input" }
