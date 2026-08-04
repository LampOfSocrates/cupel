import { marked } from "marked";
import DOMPurify from "dompurify";
import { Typography } from "@mantine/core";

// feature-spec.md:10: "Message list with streaming assistant responses
// (markdown + code blocks)".
// marked 18.0.9 — sync overload `marked(src, { async: false }): string`
// (node_modules/marked/lib/marked.d.ts:727-729); output sanitized with
// dompurify 3.4.13 (default export .sanitize, purify.es.d.mts:291) because
// marked does not sanitize. Mantine 9 `Typography` styles the raw HTML.
export function Markdown({ content }: { content: string }) {
  const html = DOMPurify.sanitize(marked(content, { async: false }));
  return (
    <Typography fz="sm" dangerouslySetInnerHTML={{ __html: html }} />
  );
}
