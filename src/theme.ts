import { createTheme, type MantineColorsTuple } from "@mantine/core";

// The design system of the Cupel handoff ("Agentic Chat with Feedback Loop",
// design_handoff_cupel_studio/README.md), transcribed into Mantine's theme.
//
// DENSITY IS THE POINT. The handoff is explicit that the small type and tight
// rows are the design, not an oversight: "this is a professional tool where
// operators scan hundreds of rows, so the small type sizes (9.5–12px) and
// tight row padding are deliberate … Do not 'improve' it by scaling everything
// up to a consumer-app default." An earlier pass here did exactly that (13–22px,
// line-height up to 1.7) while calling it Claude-like; the scale below is the
// handoff's own.
//
// Anthropic's brand typeface is licensed and not ours to bundle. IBM Plex
// Sans/Mono (OFL, self-hosted via @fontsource, imported once in main.tsx) are
// the open stand-ins the handoff itself names.
//
// SHADOWS: none, deliberately — "Depth comes from borders and the three
// background tints — keep it that way."

// The handoff's neutral ramp, lightest to darkest: canvas/surface tints, the
// three border weights, then the four text greys.
//   0 #FAF9F5 surface raised · 1 #F5F4EF canvas · 2 #F0EEE7 rail/header fill
//   3 #E4E2DA border soft · 4 #D3D1C7 border strong · 5 #B4B2A9 text quaternary
//   6 #888780 text tertiary · 7 #5C5B55 text secondary · 9 #2C2C2A text primary
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

// Accent blue, ramped so #185FA5 lands at shade 6 — Mantine's light-mode
// primaryShade default, i.e. what Button/links/focus rings use out of the box.
// Shade 0 is the handoff's accent WASH (#F3F8FD, every selected row) and shade
// 1 its badge fill (#E6F1FB, count badges and the "edited" pill); shade 8 is
// the link-hover (#12477C). Those four are the ones the design actually names.
const accentBlue: MantineColorsTuple = [
  "#F3F8FD",
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

// Warning sand — the fork badge and advisory callouts. The handoff names three
// stops: fill #FBF3DF (shade 0), border #E7D9AE (shade 2), text #8A6D1F
// (shade 7) with a darker #6B551A (shade 8) for the callout variant.
const warningSand: MantineColorsTuple = [
  "#FBF3DF",
  "#F5EACB",
  "#E7D9AE",
  "#D9C68C",
  "#C9B26B",
  "#B39A4F",
  "#9C823B",
  "#8A6D1F",
  "#6B551A",
  "#4E3D12",
];

// Danger clay — error spans in the waterfall, and the hover colour every ✕
// remove-glyph goes to. The handoff names one stop, #A33A2A (shade 7).
const dangerClay: MantineColorsTuple = [
  "#FBEEEB",
  "#F6DCD6",
  "#EBBAAF",
  "#DE9686",
  "#D07863",
  "#C05F48",
  "#B54935",
  "#A33A2A",
  "#832E21",
  "#5F2117",
];

export const theme = createTheme({
  fontFamily: "'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  fontFamilyMonospace:
    "'IBM Plex Mono', 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
  // The handoff's scale, in the order Mantine consumes it. 11px (sm) is the
  // workhorse — row content, cell text, most Text size="sm" — and 12px (lg) is
  // a heading here, not body copy. The 9.5px caption stop has no Mantine slot
  // and lives in `other.fontSizeMicro`.
  fontSizes: {
    xs: "0.625rem", // 10px — mono ids, meta lines, uppercase captions
    sm: "0.6875rem", // 11px — row and cell content
    md: "0.71875rem", // 11.5px — list row titles
    lg: "0.75rem", // 12px — page and panel titles
    xl: "1rem", // 16px — summary stat values
  },
  // Titles read `headings`, NOT `fontSizes`, so the scale above does not reach
  // them and a page title would keep Mantine's 34px h1 on an 11px page. The
  // handoff has no display type at all: its largest heading is the 12px/600
  // page title, and 15–16px appears only as summary stat VALUES. So the ramp
  // is deliberately flat — h1 is the 12px page title and the rest step down
  // through the caption stops.
  headings: {
    fontFamily: "'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    fontWeight: "600",
    sizes: {
      h1: { fontSize: "0.75rem", lineHeight: "1.4" }, // 12px — page/panel title
      h2: { fontSize: "0.71875rem", lineHeight: "1.4" }, // 11.5px — section title
      h3: { fontSize: "0.6875rem", lineHeight: "1.4" }, // 11px
      h4: { fontSize: "0.625rem", lineHeight: "1.4" }, // 10px
      h5: { fontSize: "0.625rem", lineHeight: "1.4" }, // 10px
      h6: { fontSize: "0.59375rem", lineHeight: "1.4" }, // 9.5px — micro caption
    },
  },
  // "Body line-height 1.4–1.55" — the prompt textarea's 1.75 is a component
  // rule, not a scale stop, so it lives with the editor.
  lineHeights: {
    xs: "1.4",
    sm: "1.45",
    md: "1.5",
    lg: "1.55",
    xl: "1.55",
  },
  // "5px (small controls) · 6px (inputs, buttons) · 7px (cards) · 8px (panels,
  // badges/pills) · 10px (composer)". Pills are 8px here — NOT fully rounded.
  radius: {
    xs: "0.3125rem", // 5px
    sm: "0.375rem", // 6px
    md: "0.4375rem", // 7px
    lg: "0.5rem", // 8px
    xl: "0.625rem", // 10px
  },
  defaultRadius: "sm",
  primaryColor: "accent",
  colors: {
    gray: warmGray,
    accent: accentBlue,
    warning: warningSand,
    danger: dangerClay,
  },
  // Depth comes from borders and background tints only.
  shadows: {
    xs: "none",
    sm: "none",
    md: "none",
    lg: "none",
    xl: "none",
  },
  other: {
    /** The 9.5px caption stop — below Mantine's smallest named size. */
    fontSizeMicro: "0.59375rem",
    /** Prompt/instruction textareas only (handoff: "prompt textarea 1.75"). */
    lineHeightEditor: "1.75",
    /** Uppercase caption tracking, applied wherever a 9.5–10px label is set. */
    letterSpacingCaption: "0.05em",
    /**
     * Fixed widths the handoff pins by number. Named here so a screen cites the
     * token instead of restating a magic number, and one edit moves them all.
     */
    widths: {
      sidebar: 190,
      chatList: 250,
      chatSettings: 250,
      selectedPanel: 340,
      runSetup: 380,
      runSetupWide: 560,
      runSetupMin: 300,
      promptEditorMin: 360,
      subAgentList: 210,
      subAgentListMin: 150,
      traceList: 216,
      traceDetail: 296,
      timelineMin: 260,
      pickedTurnCard: 236,
      collapsedRibbon: 46,
    },
  },
});
