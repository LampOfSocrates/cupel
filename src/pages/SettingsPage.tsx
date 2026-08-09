import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Divider,
  Group,
  Loader,
  Paper,
  PasswordInput,
  Radio,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { agenticConfig } from "../../agentic.config";
import { api } from "../api/client";
import {
  CUSTOM_TARGET_ID,
  getCustomUrl,
  setActiveTarget,
  setCustomUrl,
  useBackendTarget,
} from "../api/target";
import {
  getProdToken,
  getSseEnabled,
  setProdToken,
  setSseEnabled,
} from "../api/backendPrefs";
import { useApp } from "../AppContext";
import { AgentTreesSection, MembersSection } from "./SettingsAdmin";

// Settings → Backend (sketch 09, feature-spec.md:157-161):
// "Target switcher: Mock / Local / Staging / Prod presets + custom Base URL
// field" (:158); "Health check: GET {base}/healthz on select — shows status,
// latency, server version, and (for mock) the loaded seed" (:159, latency
// client-measured per openapi.yaml:88); "Mock options (visible when target =
// Mock)" (:160); "Target is device-local …; Prod requires an auth token
// field" (:161).
//
// Live-switch design: selecting a target calls setActiveTarget → App.tsx's
// boot effect (keyed on the active target) refetches /me + /agenttrees and
// remounts the page tree, so every store refetches against the new base.
// This page therefore keeps NO cross-switch state: the health check reruns
// from the mount/target effect after every switch.

type HealthState =
  | null
  | { kind: "checking" }
  | { kind: "ok"; latencyMs: number; version: string; seed: string | null }
  | { kind: "fail"; latencyMs: number; message: string };

// Latency/failure-injection env vars and the seed picker are Phase-2 MOCK
// deliverables that are not built yet (cupel-phases.md:98 "failure/latency
// injection env vars" ships with the generator work) — these controls render
// disabled per the sketch, wired to nothing.
const GEN_TOOLTIP = "Arrives with generator controls (P2-GEN)";

export function SettingsPage() {
  const target = useBackendTarget();
  // The admin sections are ROLE-driven — "Admin UI (visible when
  // /me grants admin)" (feature-spec.md:19). /me is fetched once at boot and
  // lives in AppContext; nothing here knows or asks how the backend
  // authenticates (invariant: the frontend never branches on the auth mode —
  // an off-mode backend simply answers /me with an admin dev user).
  const { me } = useApp();
  const isAdmin = me.roles?.includes("admin") ?? false;

  // Custom row: picking "Custom" before a URL exists cannot switch yet (an
  // empty baseUrl would mean same-origin, which is prod's semantic) — the
  // radio goes into a pending state and the URL field opens for typing;
  // committing a URL performs the actual switch.
  const [pendingCustom, setPendingCustom] = useState(false);
  const [customUrl, setCustomUrlState] = useState(getCustomUrl());
  const [token, setToken] = useState(getProdToken());
  const [sse, setSse] = useState(getSseEnabled());
  const [health, setHealth] = useState<HealthState>(null);

  const selectedId = pendingCustom ? CUSTOM_TARGET_ID : target.id;
  const selectedPreset = agenticConfig.targets.find((t) => t.id === selectedId);

  // Health check against the ACTIVE target (the client builds every URL from
  // it). seq guards a stale slow response overwriting a newer check.
  const checkSeq = useRef(0);
  const runCheck = useCallback(async () => {
    const seq = ++checkSeq.current;
    setHealth({ kind: "checking" });
    const t0 = performance.now();
    try {
      const h = await api.healthz();
      const latencyMs = Math.round(performance.now() - t0);
      if (seq !== checkSeq.current) return;
      setHealth({ kind: "ok", latencyMs, version: h.version, seed: h.seed ?? null });
    } catch (e) {
      const latencyMs = Math.round(performance.now() - t0);
      if (seq !== checkSeq.current) return;
      setHealth({
        kind: "fail",
        latencyMs,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  // "on select" (feature-spec.md:159): every target change re-checks — the
  // mount run covers both first visit and the post-switch remount.
  useEffect(() => {
    // KEPT: an imperative probe of an external system, not a read of one. The
    // `checking` state has to be entered at the moment the request is issued
    // because the result it leads to is timed from there (`latencyMs` on BOTH
    // the ok and the fail branch — which is also why this is not a useAsync).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void runCheck();
  }, [runCheck, target]);

  const onSelect = (id: string) => {
    if (id === CUSTOM_TARGET_ID) {
      if (getCustomUrl()) {
        setPendingCustom(false);
        setActiveTarget(CUSTOM_TARGET_ID);
      } else {
        setPendingCustom(true);
      }
      return;
    }
    setPendingCustom(false);
    setActiveTarget(id);
  };

  const commitCustomUrl = () => {
    const url = customUrl.trim();
    setCustomUrl(url); // persists cupel.backend.customUrl (device-local)
    if (url && selectedId === CUSTOM_TARGET_ID && target.id !== CUSTOM_TARGET_ID) {
      setPendingCustom(false);
      setActiveTarget(CUSTOM_TARGET_ID);
    }
  };

  const seed = health?.kind === "ok" ? health.seed : null;

  return (
    <Stack gap="md" maw={640}>
      <Title order={3}>Settings</Title>

      <Paper withBorder p="md" radius="md">
        <Stack gap="sm">
          <Text fw={600}>Backend</Text>

          {/* Target presets from agentic.config.ts + the Custom row. */}
          <Radio.Group label="Target" value={selectedId} onChange={onSelect}>
            <Group gap="md" mt={4}>
              {agenticConfig.targets.map((t) => (
                <Radio key={t.id} value={t.id} label={t.label} size="xs" />
              ))}
              <Radio value={CUSTOM_TARGET_ID} label="Custom" size="xs" />
            </Group>
          </Radio.Group>

          {selectedId === CUSTOM_TARGET_ID ? (
            <TextInput
              label="Base URL"
              aria-label="Base URL"
              placeholder="https://your-backend.example.com"
              value={customUrl}
              onChange={(e) => setCustomUrlState(e.currentTarget.value)}
              onBlur={commitCustomUrl}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitCustomUrl();
              }}
              size="xs"
              ff="monospace"
            />
          ) : (
            <TextInput
              label="Base URL"
              aria-label="Base URL"
              value={selectedPreset?.baseUrl || "(same origin)"}
              readOnly
              size="xs"
              ff="monospace"
            />
          )}

          <Group gap="xs" wrap="nowrap">
            <Text size="sm" c="dimmed" w={60}>
              Health
            </Text>
            {pendingCustom ? (
              <Text size="sm" c="dimmed" data-testid="health-result">
                enter a base URL to connect
              </Text>
            ) : health?.kind === "checking" ? (
              <Loader size="xs" aria-label="Checking health" />
            ) : health?.kind === "ok" ? (
              <Text size="sm" c="green.8" data-testid="health-result">
                &#x25CF; ok &middot; {health.latencyMs}ms &middot; v{health.version}
                {health.seed ? ` · seed ${health.seed}` : ""}
              </Text>
            ) : health?.kind === "fail" ? (
              <Text size="sm" c="red.8" data-testid="health-result">
                &#x25CF; fail &middot; {health.latencyMs}ms &middot; {health.message}
              </Text>
            ) : null}
            <Button
              size="compact-xs"
              variant="default"
              onClick={() => void runCheck()}
              disabled={pendingCustom}
            >
              Re-check
            </Button>
          </Group>

          {/* "Prod requires an auth token field" (feature-spec.md:161).
              Attached as a Bearer header on requiresToken targets —
              unless a login JWT exists (auth.ts precedence). */}
          {selectedPreset?.requiresToken && (
            <PasswordInput
              label="Auth token"
              aria-label="Auth token"
              description="Stored on this device only; sent as a Bearer token on this target (a signed-in session's token takes precedence)."
              value={token}
              onChange={(e) => {
                const value = e.currentTarget.value;
                setToken(value);
                setProdToken(value);
              }}
              size="xs"
              maw={360}
            />
          )}

          {/* Mock options — "visible when target = Mock" (feature-spec.md:160).
              SSE streaming is REAL today (ChatPage sends stream:<flag>,
              cupel-phases.md:43); latency / failure % / seed picker await the
              mock's injection env vars + generator control. */}
          {target.id === "mock" && (
            <>
              <Divider my={4} />
              <Text size="sm" fw={600}>
                Mock options
              </Text>
              <Group gap="lg">
                <Switch
                  label="SSE streaming"
                  size="xs"
                  checked={sse}
                  onChange={(e) => {
                    const on = e.currentTarget.checked;
                    setSse(on);
                    setSseEnabled(on);
                  }}
                />
                <Tooltip label={GEN_TOOLTIP}>
                  <span>
                    <Switch label="Simulate latency" size="xs" disabled />
                  </span>
                </Tooltip>
                <Tooltip label={GEN_TOOLTIP}>
                  <span>
                    <Switch label="Random task failures (5%)" size="xs" disabled />
                  </span>
                </Tooltip>
              </Group>
              <Tooltip label={GEN_TOOLTIP}>
                <span style={{ width: "max-content" }}>
                  <Button variant="default" size="compact-xs" disabled>
                    Seed dataset: {seed ?? "—"} &#x25BE;
                  </Button>
                </span>
              </Tooltip>
            </>
          )}
        </Stack>
      </Paper>

      {/* Settings → Members + Settings → Agent trees (feature-spec.md:19-20;
          cupel-phases.md:77) — unsketched, so they reuse this page's visual
          language (Paper block, dense xs controls) per cupel-phases.md:95. */}
      {isAdmin && (
        <>
          <MembersSection />
          <AgentTreesSection />
        </>
      )}

      {/* Per-environment note (sketch 09 bottom card). */}
      <Paper withBorder p="md" radius="md">
        <Text size="xs" c="dimmed">
          Target is device-local (not synced via /settings). Prod requires an
          auth token. Non-prod targets show a colored banner in the app chrome.
        </Text>
      </Paper>
    </Stack>
  );
}
