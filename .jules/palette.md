## 2026-03-30 - Mantine Tooltips for ActionIcon Buttons in CopyButton Wrappers
**Learning:** When wrapping an ActionIcon inside a CopyButton render prop in Mantine, placing the Tooltip inside the render prop callback allows the Tooltip label to dynamically switch between state labels (e.g., "Copy message" vs. "Copied") for immediate feedback.
**Action:** Always wrap inner ActionIcons with Tooltip inside CopyButton render props when adding tooltips to copy actions.
