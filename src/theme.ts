import { createTheme, type MantineColorsTuple } from "@mantine/core";

// Approximates the roomier, warmer feel of Claude's own UI: larger type,
// looser line-height, warm (not blue-tinted) neutrals, rounder corners.
// Anthropic's actual brand typeface is licensed and not ours to bundle;
// IBM Plex Sans/Mono (OFL, self-hosted via @fontsource, imported once in
// main.tsx) are the open stand-ins — the same family Claude.ai's own UI
// ships, so ids/counts/badges in mono read the way they do there.
//
// Palette + radius lifted from a Claude-style reference design (warm paper
// bg, ink text, borders doing the work shadows do elsewhere): #F5F4EF bg /
// #FFFFFF surface / #F0EEE7 & #FAF9F5 alt surface / #E4E2DA soft border /
// #D3D1C7 strong border / #B4B2A9 faint text / #888780 muted / #5C5B55 mid /
// #2C2C2A ink, with accent #185FA5 (hover #12477C, soft bg #E6F1FB).
const warmGray: MantineColorsTuple = [
  "#FAF9F5",
  "#F5F4EF",
  "#F0EEE7",
  "#E4E2DA",
  "#D3D1C7",
  "#B4B2A9",
  "#888780",
  "#5C5B55",
  "#3A3835",
  "#2C2C2A",
];

// Accent blue, ramped around #185FA5 so it lands at shade 6 — Mantine's
// light-mode primaryShade default, i.e. what Button/links/focus rings use
// out of the box.
const accentBlue: MantineColorsTuple = [
  "#EAF3FB",
  "#E6F1FB",
  "#C7E0F5",
  "#A3CBEC",
  "#7DB5E2",
  "#559ED7",
  "#185FA5",
  "#14528F",
  "#12477C",
  "#0D3760",
];

export const theme = createTheme({
  fontFamily:
    "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  fontFamilyMonospace:
    "'IBM Plex Mono', 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
  fontSizes: {
    xs: "0.8125rem", // 13px
    sm: "0.9375rem", // 15px — most body text (Text size="sm") renders here
    md: "1.0625rem", // 17px
    lg: "1.1875rem", // 19px
    xl: "1.375rem", // 22px
  },
  lineHeights: {
    xs: "1.5",
    sm: "1.6",
    md: "1.65",
    lg: "1.7",
    xl: "1.7",
  },
  // Reference uses 5-6px on controls, 7-8px on cards, full pill on badges —
  // sm/md/xl below map to that; defaultRadius moves every control down from
  // Mantine's stock 8px, the pill-ish look already flagged on the sidebar.
  radius: {
    xs: "0.1875rem", // 3px
    sm: "0.375rem", // 6px
    md: "0.5rem", // 8px
    lg: "0.625rem", // 10px
    xl: "1rem", // 16px — pills/chips
  },
  defaultRadius: "sm",
  primaryColor: "accent",
  colors: {
    gray: warmGray,
    accent: accentBlue,
  },
});
