# Palette's Journal - Cupel Studio UX Enhancements

## 2026-08-11 - Delayed Tooltips for High-Density Action Rows
**Learning:** In highly scrollable, high-density chat message bubbles, hovering or focusing action icons can cause aggressive tooltip clutter if not throttled. Adding an intentional delay (`openDelay={400}`) and explicit top positioning prevents accidental popups during scanning/scrolling while ensuring screen-reader description parity and visual assistance when a user purposefully pauses on an action icon.
**Action:** Always wrap icon-only controls in high-density areas with Mantine's `<Tooltip>` component configured with `openDelay={400}` and explicit positioning.
