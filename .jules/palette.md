## 2026-08-22 - ActionIcon Tooltips with Dynamic State Feedback
**Learning:** Wrapping icon-only `ActionIcon` buttons inside Mantine `Tooltip` components clarifies action intent. When nested inside dynamic render-prop components like `CopyButton`, the `Tooltip` must wrap the inner `ActionIcon` and consume the dynamic state (e.g. `copied`) so its label updates instantly from "Copy message" to "Copied!".
**Action:** Always wrap `ActionIcon` buttons in `Tooltip` components and pass dynamic state strings to the tooltip label when appropriate.
