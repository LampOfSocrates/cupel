import { createTheme, type MantineColorsTuple } from "@mantine/core";

// Approximates the roomier, warmer feel of Claude's own UI: larger type,
// looser line-height, warm (not blue-tinted) neutrals, rounder corners.
// Anthropic's actual brand typeface is licensed and not ours to bundle;
// Inter (OFL, self-hosted via @fontsource-variable/inter, imported once in
// main.tsx) is an open stand-in from the same humanist-sans family.
const warmGray: MantineColorsTuple = [
  "#fafaf9",
  "#f5f5f4",
  "#e7e5e4",
  "#d6d3d1",
  "#a8a29e",
  "#78716c",
  "#57534e",
  "#44403c",
  "#292524",
  "#1c1917",
];

export const theme = createTheme({
  fontFamily:
    "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  fontFamilyMonospace:
    "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
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
  defaultRadius: "md",
  colors: {
    gray: warmGray,
  },
});
