## 2026-08-14 - [Mantine ActionIcon Inside CopyButton Tooltip Wrapping Pattern]
**Learning:** When wrapping an ActionIcon nested inside a CopyButton or other dynamic render-prop wrappers in Mantine, the Tooltip component should wrap the inner ActionIcon and consume the dynamic state (like `copied`) to instantly update its label upon user interaction.
**Action:** Always wrap the inner ActionIcon with Tooltip inside dynamic render-prop components like CopyButton.
