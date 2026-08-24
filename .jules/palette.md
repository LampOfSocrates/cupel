## 2026-08-24 - Mantine Tooltips on Dynamic Action Buttons
**Learning:** Icon-only action buttons in message turns (Thumbs Up/Down, Copy, Fork, Collect, Trace) lack visual labels on hover without Tooltips. When nesting ActionIcons inside CopyButton render-props, wrapping the inner ActionIcon with Tooltip allows tooltips to dynamically display state changes like "Copied" or "Link copied" seamlessly.
**Action:** Always wrap icon-only ActionIcons in Mantine Tooltip components, and pass dynamic render-prop states (such as `copied`) directly into the Tooltip `label` prop for immediate feedback.
