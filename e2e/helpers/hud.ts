import { test, type Page } from "@playwright/test";

// P2-RECORD — the step HUD. Wraps `test.step` so a named step ALSO paints a
// small caption into the page: "Journey 3 · Step 2/4 — Configure: …". The
// films then narrate themselves when they are watched outside the HTML report
// (dropped into Slack, sent to a client).
//
// Two rules keep it invisible to the tests themselves:
//   1. it paints ONLY under the `record` project, so `npm run e2e` is the run
//      it always was;
//   2. the caption lives in a CLOSED shadow root on a zero-size fixed host, so
//      Playwright's selector engine cannot pierce it (no getByText can match
//      the caption) and nothing in the layout shifts.

// The host carries the z-index: `position:fixed` makes it a stacking context of
// its own, so a z-index on the caption inside would be trapped under it and the
// app's fixed sidebar (Mantine z-index 200) would paint over the banner.
const HOST_CSS = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647";
const CAPTION_CSS =
  "position:fixed;left:16px;bottom:14px;pointer-events:none;" +
  "font:600 14px/1.45 ui-sans-serif,system-ui,sans-serif;color:#fff;" +
  "background:rgba(15,15,17,.92);padding:9px 15px;border-radius:9px;" +
  "box-shadow:0 4px 16px rgba(0,0,0,.4);max-width:72vw";

/** Held on each caption so it is legible in the film; slowMo alone paces the
 *  clicks, not the reading. */
const DWELL_MS = 700;

/** Runs in the page. Creates the host once per document, then updates text. */
function paint({ text, css, hostCss }: { text: string; css: string; hostCss: string }) {
  const w = window as unknown as { __skeinHud?: (t: string) => void };
  if (!w.__skeinHud) {
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = hostCss;
    document.body.appendChild(host);
    const caption = document.createElement("div");
    caption.style.cssText = css;
    host.attachShadow({ mode: "closed" }).appendChild(caption);
    w.__skeinHud = (t: string) => void (caption.textContent = t);
  }
  w.__skeinHud(text);
}

/** A drop-in for `test.step` that also narrates on screen. `of` is the step
 *  count of THIS test — cosmetic, a drifted denominator breaks nothing. */
export function filmed(page: Page, journey: string, of: number) {
  const recording = test.info().project.name === "record";
  let caption = "";
  let n = 0;
  const show = () =>
    page.evaluate(paint, { text: caption, css: CAPTION_CSS, hostCss: HOST_CSS }).catch(() => {});
  // A navigation drops the host with the document; repaint the current step.
  if (recording) page.on("load", show);
  return <T>(title: string, body: () => Promise<T>): Promise<T> =>
    test.step(title, async () => {
      caption = `${journey} · Step ${++n}/${of} — ${title}`;
      if (recording) {
        await show();
        await page.waitForTimeout(DWELL_MS);
      }
      return body();
    });
}
