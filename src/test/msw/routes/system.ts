// Session, health, catalogue: /me, auth, /healthz, /agenttrees, /models,
// per-tree endpoints — plus the LOCAL_BASE mirror the target-switch tests boot
// the whole app against.
import { http, HttpResponse } from "msw";
import type { Endpoint, Health, Model } from "../../../api/types";
import {
  apiError,
  BASE,
  captureLlmHeaders,
  LOCAL_BASE,
  MOCK_JWT,
  mockAdminMe,
  mockMe,
  mockTrees,
  taskStreamClients,
  treeGate,
} from "../state";

export const localBaseRequests: string[] = []; // pathnames hit on LOCAL_BASE
export const localHealth: Health = { status: "ok", version: "0.9-local", seed: null };

// GET /healthz (openapi.yaml:80-96, Health :1091-1100) — backend-switcher
// check (feature-spec.md:155). status knob lets tests exercise the fail path.
export const healthConfig: { status: number; body: Health } = {
  status: 200,
  body: { status: "ok", version: "0.2.0", seed: "demo-agent1" },
};
export const healthzRequests: string[] = []; // "mock" | "local" per hit

export const authTokenRequests: Array<{ email: string; password: string }> = [];
export const logoutRequests: string[] = []; // authorization header per hit

// GET /agenttrees/{tree}/endpoints (openapi.yaml:154-172, Endpoint :1130-1138
// "an agent deployment/backend target") — ids/names mirror the real mock's
// seed (mock/seed.py:15-18, :28-30).
export const mockEndpoints: Record<string, Endpoint[]> = {
  agent1: [
    { id: "ep_agent1_prod", name: "prod", description: "Production deployment" },
    { id: "ep_agent1_staging", name: "staging", description: "Staging deployment" },
  ],
  agent2: [{ id: "ep_agent2_prod", name: "prod", description: "Production deployment" }],
};
export const endpointsRequests: string[] = []; // tree ids seen by GET endpoints

// GET /models (openapi.yaml:98-112, Model :1102-1107) — mirrors the real
// mock's list (mock/config.py:6-11). Tests count fetches via modelsRequests
// to prove the context fetches once and caches.
export const mockModels: Model[] = [
  { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  { id: "deepseek-v3", name: "DeepSeek V3" },
  { id: "gemini-flash", name: "Gemini Flash" },
];
export const modelsRequests: string[] = [];

// Curated live list mirrors mock/config.py LIVE_MODELS ("/models is populated
// from a curated cheap-model list in live mode", docs/deployment.md:22-23).
export const mockLiveModels: Model[] = [
  { id: "deepseek/deepseek-chat", name: "DeepSeek Chat" },
  { id: "google/gemini-flash-1.5", name: "Gemini Flash 1.5" },
  { id: "anthropic/claude-haiku-4.5", name: "Claude Haiku 4.5" },
];

export const systemHandlers = [
  http.get(`${BASE}/me`, () => HttpResponse.json(mockMe)),

  // POST /auth/token — 200 AuthTokenResponse for the seeded credentials,
  // 401 invalid_credentials otherwise (openapi.yaml:124-125).
  http.post(`${BASE}/auth/token`, async ({ request }) => {
    const body = (await request.json()) as { email: string; password: string };
    authTokenRequests.push(body);
    if (body.email !== "admin@demo" || body.password !== "demo") {
      return apiError("invalid_credentials", "Invalid email or password.", 401);
    }
    return HttpResponse.json({
      access_token: MOCK_JWT,
      token_type: "bearer",
      expires_in: 43200,
      me: mockAdminMe,
    });
  }),

  // POST /auth/logout — stateless 204 (openapi.yaml:139-141); the header
  // capture lets tests assert the sign-out call carried the bearer.
  http.post(`${BASE}/auth/logout`, ({ request }) => {
    logoutRequests.push(request.headers.get("authorization") ?? "");
    return new HttpResponse(null, { status: 204 });
  }),

  // GET /healthz (openapi.yaml:80-96) — status/version/seed; latency is
  // client-measured (openapi.yaml:88), so none here.
  http.get(`${BASE}/healthz`, () => {
    healthzRequests.push("mock");
    if (healthConfig.status !== 200) {
      return apiError("unavailable", "backend down", healthConfig.status);
    }
    return HttpResponse.json(healthConfig.body);
  }),

  // -------------------------------- LOCAL_BASE handlers (target switching):
  // everything a full-App boot + Settings page touch on the new base.
  http.get(`${LOCAL_BASE}/me`, () => {
    localBaseRequests.push("/me");
    return HttpResponse.json(mockMe);
  }),
  http.get(`${LOCAL_BASE}/agenttrees`, () => {
    localBaseRequests.push("/agenttrees");
    return HttpResponse.json(mockTrees);
  }),
  http.get(`${LOCAL_BASE}/healthz`, () => {
    localBaseRequests.push("/healthz");
    healthzRequests.push("local");
    return HttpResponse.json(localHealth);
  }),
  http.get(`${LOCAL_BASE}/agenttrees/:tree/conversations`, () => {
    localBaseRequests.push("/conversations");
    return HttpResponse.json({ items: [], page: 1, page_size: 20, total: 0 });
  }),
  http.get(`${LOCAL_BASE}/tasks`, () => {
    localBaseRequests.push("/tasks");
    return HttpResponse.json({ items: [], page: 1, page_size: 50, total: 0 });
  }),
  http.get(`${LOCAL_BASE}/tasks/stream`, () => {
    localBaseRequests.push("/tasks/stream");
    // Idle stream held open until abort — registered with the rig's client
    // set so resetHandlerState's closeAll cleans it up.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        taskStreamClients.add(controller);
      },
    });
    return new HttpResponse(stream, {
      headers: { "Content-Type": "text/event-stream" },
    });
  }),

  http.get(`${BASE}/agenttrees`, () => HttpResponse.json(mockTrees)),

  // GET /agenttrees/{tree}/endpoints — "Deploy targets for replay"
  // (openapi.yaml:158; feature-spec.md:117).
  http.get(`${BASE}/agenttrees/:tree/endpoints`, ({ params }) => {
    const denied = treeGate(params.tree as string);
    if (denied) return denied;
    const endpoints = mockEndpoints[params.tree as string] ?? [];
    endpointsRequests.push(params.tree as string);
    return HttpResponse.json(endpoints);
  }),

  // GET /models (openapi.yaml:98-112) — model dropdown source
  // (feature-spec.md:118). With X-LLM-Key the curated live list
  // answers instead, mirroring the real mock.
  http.get(`${BASE}/models`, ({ request }) => {
    captureLlmHeaders(request);
    modelsRequests.push("models");
    return HttpResponse.json(request.headers.get("x-llm-key") ? mockLiveModels : mockModels);
  }),
];

export function resetSystem() {
  authTokenRequests.length = 0;
  logoutRequests.length = 0;
  healthConfig.status = 200;
  healthConfig.body = { status: "ok", version: "0.2.0", seed: "demo-agent1" };
  healthzRequests.length = 0;
  localBaseRequests.length = 0;
  endpointsRequests.length = 0;
  modelsRequests.length = 0;
}
