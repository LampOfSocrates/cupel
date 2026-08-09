import type { BackendTarget } from "../../agentic.config";
import { useBackendTarget } from "../api/target";

export const ENV_BANNER_HEIGHT = 22;

// Banner config lives on the target (agentic.config.ts
// BackendTarget.banner): prod declares `false`, mock/staging declare their
// label + color. Targets with NO banner field (e.g. local, custom) fall back
// to the id-based rule — "Non-prod targets show a colored banner in
// the app chrome so nobody mistakes mock data for real" (feature-spec.md:157).
export function resolveBanner(
  target: BackendTarget,
): { label: string; color?: string } | false {
  if (target.banner !== undefined) return target.banner;
  return target.id === "prod" ? false : { label: `${target.label} backend` };
}

export function EnvBanner() {
  const banner = resolveBanner(useBackendTarget());
  if (!banner) return null;
  return (
    <div
      data-testid="env-banner"
      style={{
        height: ENV_BANNER_HEIGHT,
        lineHeight: `${ENV_BANNER_HEIGHT}px`,
        background: banner.color ?? "#e8590c",
        color: "#fff",
        textAlign: "center",
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 1,
        textTransform: "uppercase",
      }}
    >
      {banner.label}
    </div>
  );
}
