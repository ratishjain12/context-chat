// Mirrors worker/file-types.ts -- keep both in sync if this changes. This
// copy exists only for client-side UX (accept filter, early rejection);
// the Worker is the authoritative gate.
export type FileCategory = "image" | "document" | "data";

interface FileRule {
  category: FileCategory;
  mimeType: string;
  maxBytes: number;
}

const MB = 1024 * 1024;

export const FILE_RULES: Record<string, FileRule> = {
  png: { category: "image", mimeType: "image/png", maxBytes: 10 * MB },
  jpg: { category: "image", mimeType: "image/jpeg", maxBytes: 10 * MB },
  jpeg: { category: "image", mimeType: "image/jpeg", maxBytes: 10 * MB },
  webp: { category: "image", mimeType: "image/webp", maxBytes: 10 * MB },
  gif: { category: "image", mimeType: "image/gif", maxBytes: 10 * MB },
  pdf: { category: "document", mimeType: "application/pdf", maxBytes: 20 * MB },
  txt: { category: "document", mimeType: "text/plain", maxBytes: 20 * MB },
  md: { category: "document", mimeType: "text/markdown", maxBytes: 20 * MB },
  docx: {
    category: "document",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    maxBytes: 20 * MB,
  },
  csv: { category: "data", mimeType: "text/csv", maxBytes: 5 * MB },
};

// Soft hint for the OS file picker + PromptInput's own drag/paste filter.
// Includes application/octet-stream since browsers fall back to it for
// extensions they don't recognize (.md especially) -- the Worker enforces
// the real per-extension limits regardless.
export const ACCEPTED_MIME_TYPES = [
  ...new Set(Object.values(FILE_RULES).map((r) => r.mimeType)),
  "application/octet-stream",
].join(",")

export function ruleForFilename(filename: string): FileRule | null {
  const ext = filename.split(".").pop()?.toLowerCase()
  return (ext && FILE_RULES[ext]) || null
}
