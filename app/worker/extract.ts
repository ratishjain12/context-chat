import { getDocumentProxy, extractText } from "unpdf";
import { unzipSync, strFromU8 } from "fflate";

export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

// docx is a zip of XML parts -- word/document.xml holds the body. Real
// docx parsing (styles, tables, images) is a much bigger job than this app
// needs; regex-extracting <w:t> run text per <w:p> paragraph is enough to
// get plain readable text for RAG/inline context.
export function extractDocxText(bytes: Uint8Array): string {
  const files = unzipSync(bytes, { filter: (file) => file.name === "word/document.xml" });
  const xml = files["word/document.xml"];
  if (!xml) {
    return "";
  }

  return strFromU8(xml)
    .split(/<\/w:p>/)
    .map((paragraph) => {
      const runs = paragraph.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) ?? [];
      return runs.map((run) => run.replace(/<[^>]+>/g, "")).join("");
    })
    .filter((line) => line.length > 0)
    .join("\n");
}
