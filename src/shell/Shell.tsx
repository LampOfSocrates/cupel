import { Outlet } from "react-router";
import { AppShell } from "@mantine/core";
import { useBackendTarget } from "../api/target";
import { EnvBanner, ENV_BANNER_HEIGHT, resolveBanner } from "./EnvBanner";
import { Sidebar } from "./Sidebar";

// Shell frame per sketches/clean/01-chat.svg: left sidebar + main content.
// Banner-declaring targets add a slim header (per-target config via
// resolveBanner, P2-T17; feature-spec.md:161); the header slot only exists
// then, so prod loses no vertical space.
export function Shell() {
  const banner = resolveBanner(useBackendTarget()) !== false;
  return (
    <AppShell
      header={banner ? { height: ENV_BANNER_HEIGHT } : undefined}
      navbar={{ width: 280, breakpoint: "xs" }}
      padding="md"
    >
      {banner && (
        <AppShell.Header withBorder={false}>
          <EnvBanner />
        </AppShell.Header>
      )}
      <AppShell.Navbar p="xs">
        <Sidebar />
      </AppShell.Navbar>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
