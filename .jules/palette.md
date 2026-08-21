## 2026-08-11 - Dynamic Tooltip Labels for Mantine ActionIcon Copy Buttons
**Learning:** Icon-only action buttons and CopyButtons in message bubbles lack hover clarity without Tooltips, but static Tooltips on CopyButtons fail to communicate state changes when content is copied.
**Action:** When wrapping an ActionIcon nested inside a CopyButton or other dynamic render-prop wrappers in Mantine, wrap the inner ActionIcon with Tooltip and consume the dynamic state (like `copied`) to instantly update its label upon user interaction.
