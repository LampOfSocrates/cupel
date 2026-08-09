import { memo, useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { Typography } from "@mantine/core";

// feature-spec.md:10: "Message list with streaming assistant responses
// (markdown + code blocks)".
// marked 18.0.9 — sync overload `marked(src, { async: false }): string`
// (node_modules/marked/lib/marked.d.ts:727-729); output sanitized with
// dompurify 3.4.13 (default export .sanitize, purify.es.d.mts:291) because
// marked does not sanitize. Mantine 9 `Typography` styles the raw HTML.
//
// Parse+sanitize is the single hottest main-thread cost in the app: every
// transcript turn and every one of an evaluation grid's cells renders one of these,
// and a streaming token re-renders the whole page. memo + useMemo make the
// work proportional to CHANGED content instead of to renders
// (docs/review-2026-08-05.md A4) — content is a string, so memo's shallow
// prop compare is exact here.
export const Markdown = memo(function Markdown({ content }: { content: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked(content, { async: false })),
    [content],
  );
  return (
    <Typography fz="sm" dangerouslySetInnerHTML={{ __html: html }} />
  );
});
