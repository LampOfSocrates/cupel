import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

// Who names the page.
//
// The handoff puts the page title and its subtitle in the TOP BAR, once, above
// every screen — not inside each screen's own body. So the title has to travel
// from the route that knows it up to the shell that renders it, and this is the
// channel: the shell reads `header`, a page sets it with usePageHeader().
//
// A page that sets nothing still gets a title. The route-derived default
// (src/shell/routeTitle.ts) covers every door in the sidebar, so adding a route
// never leaves the bar blank, and a page only opts in when it has something
// more specific to say than its route does — a conversation's title, a
// benchmark's name.

export interface PageHeader {
  title: string;
  /** 11px #888780 line under the title. Omitted = title alone. */
  subtitle?: string | null;
}

interface PageHeaderState {
  header: PageHeader | null;
  setHeader: (header: PageHeader | null) => void;
}

const Ctx = createContext<PageHeaderState | null>(null);

export function PageHeaderProvider({ children }: { children: ReactNode }) {
  const [header, setHeader] = useState<PageHeader | null>(null);
  const value = useMemo(() => ({ header, setHeader }), [header]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The shell's side: what to render in the bar right now. */
export function usePageHeaderValue(): PageHeader | null {
  return useContext(Ctx)?.header ?? null;
}

/**
 * A page's side: claim the top bar while mounted, release it on unmount.
 *
 * Released on unmount so a route that sets nothing never inherits the last
 * page's title — the bar falls back to the route-derived default instead of
 * lying about where you are.
 */
export function usePageHeader(title: string, subtitle?: string | null): void {
  const ctx = useContext(Ctx);
  const setHeader = ctx?.setHeader;
  useEffect(() => {
    if (!setHeader) return;
    setHeader({ title, subtitle });
    return () => setHeader(null);
  }, [setHeader, title, subtitle]);
}
