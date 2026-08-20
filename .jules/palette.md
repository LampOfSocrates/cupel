## 2026-08-20 - Dynamic CopyButton Tooltips
**Learning:** Wrapping an ActionIcon nested inside a CopyButton or other dynamic render-prop wrappers with Mantine's Tooltip component allows the Tooltip label to reactively display updated copy feedback (e.g. "Copied!" or "Link copied!") instantly upon click, improving hover clarity and user confidence.
**Action:** Always wrap inner ActionIcons inside render-prop wrappers with Tooltip and pass dynamic state (`copied`) into the label.
