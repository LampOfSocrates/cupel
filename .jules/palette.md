# Palette's Journal

## 2026-08-05 - ActionIcon Tooltips in Dynamic Wrappers
**Learning:** When wrapping an ActionIcon nested inside a CopyButton or other dynamic render-prop wrappers in Mantine, the Tooltip component should wrap the inner ActionIcon and consume the dynamic state (like `copied`) to instantly update its label upon user interaction.
**Action:** Wrap inner ActionIcon with Tooltip inside render-prop components so state-dependent labels (e.g., "Copy message" -> "Copied") update instantly.
