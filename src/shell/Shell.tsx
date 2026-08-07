import { useEffect } from "react";
import { Outlet, useLocation } from "react-router";
import { AppShell, Burger, Group, Text } from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { useBackendTarget } from "../api/target";
import { EnvBanner, ENV_BANNER_HEIGHT, resolveBanner } from "./EnvBanner";
import { Sidebar } from "./Sidebar";

// P2-MOBILE-SHELL — the navbar breakpoint is load-bearing, not cosmetic:
// BELOW it Mantine renders the navbar as a full-width overlay
// (assign-navbar-variables.mjs sets --app-shell-navbar-width:100% and
// navbar-offset:0), so without a `collapsed.mobile` state it simply buries the
// page — the reported bug ("in portrait I only see the sidebar"). `sm`
// (48em/768px) puts phones in portrait AND landscape on the burger; tablets
// and desktops keep the fixed 280px column and are untouched.
const NAV_BREAKPOINT = "sm";
// One pixel-equivalent below theme.breakpoints.sm, so exactly one of
// "burger" / "fixed column" is true at any width. Drives what JS needs to know
// (is there a burger, how tall is the header); the collapse itself is CSS.
const NAV_MOBILE_QUERY = "(max-width: 47.99em)";
const MOBILE_BAR_HEIGHT = 44;

// Shell frame per sketches/clean/01-chat.svg: left sidebar + main content.
// Banner-declaring targets add a slim header (per-target config via
// resolveBanner, P2-T17; feature-spec.md:161); on phones the header also
// carries the burger, so the header slot exists when EITHER applies and prod
// on desktop still loses no vertical space.
export function Shell() {
  const banner = resolveBanner(useBackendTarget()) !== false;
  // getInitialValueInEffect:false → matchMedia is read during the first render
  // (this is a CSR-only Vite app, no hydration to mismatch), so the burger
  // never flashes in on a desktop load or in after a phone load.
  const isMobile = useMediaQuery(NAV_MOBILE_QUERY, false, { getInitialValueInEffect: false });
  const [navOpened, { toggle: toggleNav, close: closeNav }] = useDisclosure(false);

  // THE reported bug: tapping "New chat" (or a conversation) DID change the
  // route, the full-width overlay just stayed on top of it. Fixed centrally —
  // one effect, keyed on the location key, rather than a close() sprinkled
  // through every sidebar onClick: it covers everything that can navigate from
  // the navbar (conversation rows, fork rows, nav links, Tune/Evaluate
  // presets, Settings, sign-out) plus anything added later, and it cannot
  // drift out of sync with the router. The KEY, not the pathname: react-router
  // mints a fresh key per history entry (history.js:227), so "New chat" while
  // already on /chat — same pathname — still closes the overlay. Desktop is
  // unaffected either way: `opened` only feeds collapsed.mobile, which Mantine
  // applies below the breakpoint only.
  const { key: locationKey } = useLocation();
  useEffect(() => {
    closeNav();
  }, [locationKey, closeNav]);

  const headerHeight = (banner ? ENV_BANNER_HEIGHT : 0) + (isMobile ? MOBILE_BAR_HEIGHT : 0);

  return (
    <AppShell
      header={headerHeight > 0 ? { height: headerHeight } : undefined}
      navbar={{ width: 280, breakpoint: NAV_BREAKPOINT, collapsed: { mobile: !navOpened } }}
      padding="md"
    >
      {headerHeight > 0 && (
        <AppShell.Header withBorder={isMobile}>
          {banner && <EnvBanner />}
          {isMobile && (
            <Group h={MOBILE_BAR_HEIGHT} px="xs" gap="sm" wrap="nowrap">
              <Burger
                opened={navOpened}
                onClick={toggleNav}
                size="sm"
                aria-label="Toggle navigation"
                aria-expanded={navOpened}
                aria-controls="cupel-navbar"
              />
              <Text fw={600} size="sm">
                Cupel
              </Text>
            </Group>
          )}
        </AppShell.Header>
      )}
      <AppShell.Navbar
        id="cupel-navbar"
        p="xs"
        data-testid="app-navbar"
        // Mirrors the collapsed state that CSS applies, for tests and for
        // anyone inspecting the DOM: jsdom evaluates no media queries.
        data-collapsed={isMobile && !navOpened ? "true" : "false"}
      >
        <Sidebar />
      </AppShell.Navbar>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
