import { useBackendTarget } from "../api/target";

export const ENV_BANNER_HEIGHT = 22;

// P2-CONFIG — "Non-prod targets show a colored banner in the app chrome so
// nobody mistakes mock data for real" (feature-spec.md:161). Rendered inside
// the Shell's AppShell.Header; prod (the deployed default) shows nothing.
export function EnvBanner() {
  const target = useBackendTarget();
  if (target.id === "prod") return null;
  return (
    <div
      data-testid="env-banner"
      style={{
        height: ENV_BANNER_HEIGHT,
        lineHeight: `${ENV_BANNER_HEIGHT}px`,
        background: "#e8590c",
        color: "#fff",
        textAlign: "center",
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 1,
        textTransform: "uppercase",
      }}
    >
      {target.label} backend
    </div>
  );
}
