import { Outlet } from "react-router";
import { AppShell } from "@mantine/core";
import { Sidebar } from "./Sidebar";

// Shell frame per sketches/clean/01-chat.svg: left sidebar + main content.
export function Shell() {
  return (
    <AppShell navbar={{ width: 280, breakpoint: "xs" }} padding="md">
      <AppShell.Navbar p="xs">
        <Sidebar />
      </AppShell.Navbar>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
