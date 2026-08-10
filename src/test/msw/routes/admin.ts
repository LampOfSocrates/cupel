// Admin surface: users + the per-tree permission matrix, the tree enable
// toggle, and the cross-user Inspector listing.
import { http, HttpResponse } from "msw";
import type {
  AdminConversationItem,
  AdminUser,
  AdminUserUpsert,
  TreePermission,
} from "../../../api/types";
import {
  apiError,
  BASE,
  conv,
  counters,
  mockTrees,
  pageOf,
} from "../state";
import { mockRoots } from "./conversations";

// Admin fixtures — GET/PUT /admin/users (openapi.yaml:169-218),
// GET/PUT /admin/users/{userId}/permissions (:220-265), PATCH
// /admin/agenttrees/{treeId} (:267-296). Users mirror the real mock's seeded
// pair (mock/auth.py SEED_USERS); AdminUser carries roles only —
// "per-tree rights live in the permission matrix" (openapi.yaml:3019).
function seedAdminUsers(): AdminUser[] {
  return [
    {
      id: "u_admin",
      name: "Admin",
      email: "admin@demo",
      roles: ["admin", "inspect"],
      invited: false,
      created_at: "2026-07-01T10:00:00Z",
    },
    {
      id: "u_restricted",
      name: "Restricted",
      email: "restricted@demo",
      roles: [],
      invited: false,
      created_at: "2026-07-01T10:00:00Z",
    },
  ];
}
export const mockAdminUsers: AdminUser[] = seedAdminUsers();

function seedPermissionMatrices(): Record<string, Record<string, TreePermission[]>> {
  return {
    u_admin: {
      agent1: ["view", "tune", "evaluate"],
      agent2: ["view", "tune", "evaluate"],
    },
    u_restricted: { agent1: ["view", "evaluate"] },
  };
}
export const mockPermissionMatrices: Record<
  string,
  Record<string, TreePermission[]>
> = seedPermissionMatrices();

export const permissionPuts: Array<{
  userId: string;
  permissions: Record<string, TreePermission[]>;
}> = [];
export const adminUserUpserts: AdminUserUpsert[] = [];
export const treeTogglePatches: Array<{ treeId: string; enabled: boolean }> = [];

// -------------------------------------------- Inspector + casebooks (v0.3.0)
// GET /admin/conversations (openapi.yaml:298-348) — "Inspector — every
// conversation, cross-user"; the handler applies the contract's six filters and
// page/page_size so a test can prove a control reaches the right query param.
// Rows reuse the conversation fixtures (same ids as mockRoots) so selecting a
// row can then load its transcript through the ordinary conversation route.
function adminRow(
  id: string,
  user_id: string,
  extra: Partial<AdminConversationItem> = {},
): AdminConversationItem {
  const base =
    mockRoots.find((c) => c.id === id) ??
    conv({ id, title: id, last_activity_at: "2026-08-04T09:00:00Z" });
  const { turns: _turns, ...row } = base;
  return { ...row, user_id, user_email: null, latest_score: null, ...extra };
}

function seedAdminConversations(): AdminConversationItem[] {
  return [
    adminRow("c1", "u_admin", { user_email: "admin@demo", latest_score: 0.92 }),
    adminRow("c2", "gen-persona-2", { latest_score: 0.31 }),
    adminRow("c3", "gen-persona-5", { tree_id: "agent2" }),
  ];
}
export const mockAdminConversations: AdminConversationItem[] = seedAdminConversations();
/** Full request URLs — tests assert the filter → query-param mapping. */
export const adminConversationRequests: URL[] = [];
/** Flip to make the endpoint answer 403, as a backend without the role would. */
export const adminConversationConfig: { forbidden: boolean } = { forbidden: false };

export const adminHandlers = [
  // GET /admin/users — "Every user, cross-user (admin-only)"
  // (openapi.yaml:184). Role gating is SERVER-side (403 Forbidden,
  // openapi.yaml:1966-1970); the UI hides the section on /me.roles instead of
  // relying on the error, so the happy path here always answers 200.
  http.get(`${BASE}/admin/users`, ({ request }) =>
    HttpResponse.json(pageOf(mockAdminUsers, new URL(request.url), 50)),
  ),

  // PUT /admin/users — "upsert keyed by email: a new email creates an invited
  // user ...; an existing email updates name/roles" (openapi.yaml:195-200).
  http.put(`${BASE}/admin/users`, async ({ request }) => {
    const body = (await request.json()) as AdminUserUpsert[];
    adminUserUpserts.push(...body);
    const out: AdminUser[] = [];
    for (const item of body) {
      const existing = mockAdminUsers.find((u) => u.email === item.email);
      if (existing) {
        if (item.name != null) existing.name = item.name;
        if (item.roles != null) existing.roles = item.roles;
        out.push(existing);
      } else {
        const created: AdminUser = {
          id: `u-new-${++counters.adminUser}`,
          name: item.name ?? item.email,
          email: item.email,
          roles: item.roles ?? [],
          invited: true,
          created_at: new Date().toISOString(),
        };
        mockAdminUsers.push(created);
        mockPermissionMatrices[created.id] = {};
        out.push(created);
      }
    }
    return HttpResponse.json(out);
  }),

  // GET/PUT /admin/users/{userId}/permissions — "Same shape as Me.permissions
  // so the admin UI and /me agree exactly" (openapi.yaml:229-231); PUT is a
  // "Full replacement of the matrix" (:246).
  http.get(`${BASE}/admin/users/:userId/permissions`, ({ params }) => {
    const userId = params.userId as string;
    if (!mockAdminUsers.some((u) => u.id === userId)) {
      return apiError("not_found", "user not found", 404);
    }
    return HttpResponse.json({
      user_id: userId,
      permissions: mockPermissionMatrices[userId] ?? {},
    });
  }),

  http.put(`${BASE}/admin/users/:userId/permissions`, async ({ params, request }) => {
    const userId = params.userId as string;
    const body = (await request.json()) as {
      permissions: Record<string, TreePermission[]>;
    };
    permissionPuts.push({ userId, permissions: body.permissions });
    if (!mockAdminUsers.some((u) => u.id === userId)) {
      return apiError("not_found", "user not found", 404);
    }
    mockPermissionMatrices[userId] = body.permissions;
    return HttpResponse.json({ user_id: userId, permissions: body.permissions });
  }),

  // PATCH /admin/agenttrees/{treeId} {enabled} — "toggles availability, never
  // data" (openapi.yaml:279-280).
  http.patch(`${BASE}/admin/agenttrees/:treeId`, async ({ params, request }) => {
    const treeId = params.treeId as string;
    const body = (await request.json()) as { enabled: boolean };
    treeTogglePatches.push({ treeId, enabled: body.enabled });
    const tree = mockTrees.find((t) => t.id === treeId);
    if (!tree) {
      return apiError("not_found", "tree not found", 404);
    }
    tree.enabled = body.enabled;
    return HttpResponse.json(tree);
  }),

  // GET /admin/conversations (openapi.yaml:298-348) — the Inspector table.
  http.get(`${BASE}/admin/conversations`, ({ request }) => {
    const url = new URL(request.url);
    adminConversationRequests.push(url);
    if (adminConversationConfig.forbidden) {
      return apiError("forbidden", "The inspect role is required.", 403);
    }
    const q = url.searchParams;
    let items = [...mockAdminConversations];
    const userId = q.get("user_id");
    if (userId) items = items.filter((i) => i.user_id === userId);
    const tree = q.get("tree");
    if (tree) items = items.filter((i) => i.tree_id === tree);
    const from = q.get("date_from");
    if (from) items = items.filter((i) => i.last_activity_at.slice(0, 10) >= from);
    const to = q.get("date_to");
    if (to) items = items.filter((i) => i.last_activity_at.slice(0, 10) <= to);
    const min = q.get("score_min");
    if (min !== null) {
      items = items.filter((i) => typeof i.latest_score === "number" && i.latest_score >= Number(min));
    }
    const max = q.get("score_max");
    if (max !== null) {
      items = items.filter((i) => typeof i.latest_score === "number" && i.latest_score <= Number(max));
    }
    const page = Number(q.get("page") ?? 1);
    const pageSize = Number(q.get("page_size") ?? 50);
    const total = items.length;
    return HttpResponse.json({
      items: items.slice((page - 1) * pageSize, page * pageSize),
      page,
      page_size: pageSize,
      total,
    });
  }),
];

// Must run AFTER resetConversations: the Inspector rows are built from the
// freshly reseeded conversation fixtures.
export function resetAdmin() {
  mockAdminUsers.length = 0;
  mockAdminUsers.push(...seedAdminUsers());
  for (const key of Object.keys(mockPermissionMatrices)) delete mockPermissionMatrices[key];
  Object.assign(mockPermissionMatrices, seedPermissionMatrices());
  permissionPuts.length = 0;
  adminUserUpserts.length = 0;
  treeTogglePatches.length = 0;
  mockAdminConversations.length = 0;
  mockAdminConversations.push(...seedAdminConversations());
  adminConversationRequests.length = 0;
  adminConversationConfig.forbidden = false;
}
