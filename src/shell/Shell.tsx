import { useEffect } from "react";
import { Outlet, useLocation } from "react-router";
import { AppShell, Burger, Group, Text } from "@mantine/core";
import { useDisclosure, useLocalStorage, useMediaQuery } from "@mantine/hooks";
import { useBackendTarget } from "../api/target";
import { product } from "../lib/product";
import { mockedFamilyOfRoute } from "../lib/families";
import { EnvBanner, ENV_BANNER_HEIGHT, resolveBanner } from "./EnvBanner";
import { MockBadge } from "./MockBadge";
import { Sidebar } from "./Sidebar";

// The navbar breakpoint is load-bearing, not cosmetic:
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
// Two desktop widths, toggled rather than dragged — same pattern as Claude's
// own UI / Slack / VS Code, and it sidesteps drag-resize's edge cases (min/max
// clamping, cursor affordance, touch support). Persisted device-locally, same
// convention as the backend-target picker (src/api/target.ts).
const NAVBAR_WIDTH = 280;
const NAVBAR_RAIL_WIDTH = 68;

// Shell frame per sketches/clean/01-chat.svg: left sidebar + main content.
// Banner-declaring targets add a slim header (per-target config via
// resolveBanner; feature-spec.md:157); on phones the header also
// carries the burger, so the header slot exists when EITHER applies and prod
// on desktop still loses no vertical space.
export function Shell() {
  const banner = resolveBanner(useBackendTarget()) !== false;
  // getInitialValueInEffect:false → matchMedia is read during the first render
  // (this is a CSR-only Vite app, no hydration to mismatch), so the burger
  // never flashes in on a desktop load or in after a phone load.
  const isMobile = useMediaQuery(NAV_MOBILE_QUERY, false, { getInitialValueInEffect: false });
  const [navOpened, { toggle: toggleNav, close: closeNav }] = useDisclosure(false);
  // Rail collapse is a desktop-only concept — the mobile overlay is already
  // full-width-or-nothing (comment above), so a rail state on top of it would
  // be a third, untested combination for no benefit.
  const [railCollapsed, setRailCollapsed] = useLocalStorage({
    key: "cupel-sidebar-rail-collapsed",
    defaultValue: false,
  });
  const collapsed = !isMobile && railCollapsed;

  // THE reported bug: tapping "New chat" (or a conversation) DID change the
  // route, the full-width overlay just stayed on top of it. Fixed centrally —
  // one effect, keyed on the location key, rather than a close() sprinkled
  // through every sidebar onClick: it covers everything that can navigate from
  // the navbar (conversation rows, fork rows, nav links, Settings,
  // sign-out) plus anything added later, and it cannot
  // drift out of sync with the router. The KEY, not the pathname: react-router
  // mints a fresh key per history entry (history.js:227), so "New chat" while
  // already on /chat — same pathname — still closes the overlay. Desktop is
  // unaffected either way: `opened` only feeds collapsed.mobile, which Mantine
  // applies below the breakpoint only.
  const { key: locationKey, pathname } = useLocation();
  useEffect(() => {
    closeNav();
  }, [locationKey, closeNav]);

  // The mock badge shares the mobile bar rather than claiming a strip of its
  // own: on a page the bundled mock answers, that bar exists on every width.
  const mockedFamily = mockedFamilyOfRoute(pathname);
  const barHeight = isMobile || mockedFamily ? MOBILE_BAR_HEIGHT : 0;
  const headerHeight = (banner ? ENV_BANNER_HEIGHT : 0) + barHeight;

  return (
    <AppShell
      header={headerHeight > 0 ? { height: headerHeight } : undefined}
      navbar={{
        width: collapsed ? NAVBAR_RAIL_WIDTH : NAVBAR_WIDTH,
        breakpoint: NAV_BREAKPOINT,
        collapsed: { mobile: !navOpened },
      }}
      padding="md"
    >
      {headerHeight > 0 && (
        <AppShell.Header withBorder={barHeight > 0}>
          {banner && <EnvBanner />}
          {barHeight > 0 && (
            <Group h={MOBILE_BAR_HEIGHT} px="xs" gap="sm" wrap="nowrap">
              {isMobile && (
                <>
                  <Burger
                    opened={navOpened}
                    onClick={toggleNav}
                    size="sm"
                    aria-label="Toggle navigation"
                    aria-expanded={navOpened}
                    aria-controls="cupel-navbar"
                  />
                  <Text fw={600} size="sm">
                    {product.label}
                  </Text>
                </>
              )}
              {mockedFamily && <MockBadge family={mockedFamily} />}
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
        data-rail-collapsed={collapsed ? "true" : "false"}
      >
        <Sidebar
          collapsed={collapsed}
          // Only offered on desktop — the mobile overlay stays full-width,
          // labeled nav; there is no icon rail to toggle into there.
          onToggleCollapsed={isMobile ? undefined : () => setRailCollapsed((v) => !v)}
        />
      </AppShell.Navbar>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
