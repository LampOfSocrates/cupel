import { Outlet } from "react-router";
import { AppShell } from "@mantine/core";
import { useBackendTarget } from "../api/target";
import { EnvBanner, ENV_BANNER_HEIGHT } from "./EnvBanner";
import { Sidebar } from "./Sidebar";

// Shell frame per sketches/clean/01-chat.svg: left sidebar + main content.
// Non-prod targets add a slim header banner (P2-CONFIG, feature-spec.md:161);
// the header slot only exists then, so prod loses no vertical space.
export function Shell() {
  const nonProd = useBackendTarget().id !== "prod";
  return (
    <AppShell
      header={nonProd ? { height: ENV_BANNER_HEIGHT } : undefined}
      navbar={{ width: 280, breakpoint: "xs" }}
      padding="md"
    >
      {nonProd && (
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
