// Chosen file-format policy (matches src/lib/file-types.ts on the frontend --
// keep both in sync if this changes). Validated by file extension, not the
// client-supplied Content-Type: browsers unreliably report MIME types for
// some extensions (.md in particular often comes through as text/plain or
// application/octet-stream), so the extension is the trustworthy signal and
// the mimeType below is what we actually store/serve.
export type FileCategory = "image" | "document" | "data";

export interface FileRule {
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

export function ruleForFilename(filename: string): FileRule | null {
  const ext = filename.split(".").pop()?.toLowerCase();
  return (ext && FILE_RULES[ext]) || null;
}
