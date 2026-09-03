import { product } from "../lib/product";

// The top bar's fallback name for a route, for pages that do not set one
// themselves (src/shell/PageHeaderContext.tsx). Pure — a pathname in, a
// {title, subtitle} out — so it is testable without a router.
//
// Longest prefix wins, so /studio/evaluations beats /studio. Subtitles are the
// handoff's own register: a sentence that says what the screen is for, not a
// restatement of the title.

interface RouteTitle {
  title: string;
  subtitle?: string;
}

// Ordered longest-prefix-first; the first match wins.
const ROUTES: Array<[prefix: string, entry: RouteTitle]> = [
  ["/studio/evaluations", { title: "Evaluations", subtitle: "Replay turns and compare what comes back" }],
  ["/studio/benchmarks", { title: "Benchmarks", subtitle: "Frozen sets of cases to run against" }],
  ["/studio/feedbacks", { title: "Feedbacks", subtitle: "Thumbs and the notes people left with them" }],
  ["/studio/rubrics", { title: "Rubrics", subtitle: "How the judge scores an answer" }],
  ["/studio/inspector", { title: "Inspector", subtitle: "Raw contract responses, as served" }],
  ["/studio/cases", { title: "Cases", subtitle: "Input, output and the answer you expected" }],
  ["/studio", { title: "Studio", subtitle: "Build, evaluate and trace" }],
  ["/agents", { title: "Agents", subtitle: "The tree, and the instructions each agent runs" }],
  ["/queue", { title: "Work", subtitle: "Runs in flight and what they finished" }],
  ["/trace", { title: "Trace", subtitle: "Every span of one turn" }],
  ["/forks", { title: "Fork compare", subtitle: "The original turn beside its re-runs" }],
  ["/settings", { title: "Settings", subtitle: "Backend, model key and this device's choices" }],
  // Chat gets no subtitle: the thread's own title lands here via
  // usePageHeader, and a standing description under it would just be noise.
  ["/chat", { title: "Chat" }],
];

export function routeTitle(pathname: string): RouteTitle {
  const hit = ROUTES.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  // No match is a real state — a redirect mid-flight, an unknown path about to
  // bounce — and the product's own name is the honest thing to show, never a
  // guess at what the URL might have meant.
  return hit ? hit[1] : { title: product.label };
}
