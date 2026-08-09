// The queue: task list/detail, the live SSE stream, retry-failed, and cancel
// (which doubles as chat stop-generation).
import { http, HttpResponse } from "msw";
import type { Task } from "../../../api/types";
import { BASE, cancelledTasks, sseEncoder, taskStreamClients } from "../state";

// ---------------------------------------------------------------- task state
// GET /tasks + /tasks/{id} + retry-failed fixtures (openapi.yaml:747-865).
// Parents stored with children INLINE; the list handler strips them
// ("Parents only ... expand via GET /tasks/{id}", openapi.yaml:770-771).
// Mutable — tests flip statuses then poke taskStreamRig; reset reseeds.
function seedTasks(): Task[] {
  return [
    {
      // Running replay batch with a failed child → partial failure
      // (feature-spec.md:106); result.evaluation_id feeds "View results".
      id: "task-seed-replay",
      type: "replay",
      status: "running",
      progress: { done: 1, total: 3, stage: "Conversation 2/3 · turn 1/2" },
      result: { evaluation_id: "evaluation-old-1" },
      created_at: "2026-08-04T10:05:00Z",
      started_at: "2026-08-04T10:05:01Z",
      children: [
        {
          id: "task-seed-replay-c1",
          type: "replay",
          status: "done",
          parent_id: "task-seed-replay",
          progress: { done: 2, total: 2, stage: "conv c1" },
          created_at: "2026-08-04T10:05:00Z",
          started_at: "2026-08-04T10:05:01Z",
          finished_at: "2026-08-04T10:05:20Z",
        },
        {
          id: "task-seed-replay-c2",
          type: "replay",
          status: "running",
          parent_id: "task-seed-replay",
          progress: { done: 1, total: 2, stage: "conv c2" },
          created_at: "2026-08-04T10:05:00Z",
          started_at: "2026-08-04T10:05:21Z",
        },
        {
          id: "task-seed-replay-c3",
          type: "replay",
          status: "failed",
          parent_id: "task-seed-replay",
          progress: { done: 0, total: 2 },
          error: "endpoint returned 502",
          created_at: "2026-08-04T10:05:00Z",
        },
      ],
    },
    {
      // Finished turn fork — result.conversation_id feeds "Open in Chat"
      // (Task.result, openapi.yaml:1744-1752).
      id: "task-seed-fork",
      type: "replay_turn",
      status: "done",
      progress: { done: 1, total: 1 },
      result: { conversation_id: "fork-c1-1", turn_id: "t2" },
      created_at: "2026-08-04T09:00:00Z",
      started_at: "2026-08-04T09:00:01Z",
      finished_at: "2026-08-04T09:00:20Z",
    },
  ];
}
export const mockTasks: Task[] = seedTasks();
export const taskListRequests: string[] = []; // full URLs (polling assertions)
export const taskDetailRequests: string[] = [];
export const retryFailedRequests: string[] = [];
export const cancelRequests: string[] = []; // task ids seen by DELETE /tasks/{id}

export const taskHandlers = [
  // GET /tasks (openapi.yaml:747-775) — "Tasks, newest first. Parents only
  // (unless parent_id given)"; status/parent_id/limit params (:755-767).
  // Registered before /tasks/:taskId so the static segment wins.
  http.get(`${BASE}/tasks`, ({ request }) => {
    taskListRequests.push(request.url);
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const parentId = url.searchParams.get("parent_id");
    const limit = Number(url.searchParams.get("limit") ?? "50");
    let list: Task[] = parentId
      ? (mockTasks.find((t) => t.id === parentId)?.children ?? [])
      : mockTasks
          .slice()
          // "Tasks, newest first" (openapi.yaml:769; mock/main.py:1363 ORDER BY
          // rowid DESC). Children keep insertion order, as in the real mock
          // (mock/main.py:1405 ORDER BY rowid).
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .map(({ children: _children, ...task }) => task);
    if (status) list = list.filter((t) => t.status === status);
    return HttpResponse.json(list.slice(0, limit));
  }),

  // GET /tasks/stream (openapi.yaml:777-813) — held open until the client
  // aborts; frames pushed via taskStreamRig.emit.
  http.get(`${BASE}/tasks/stream`, () => {
    let ctrl: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        ctrl = controller;
        taskStreamClients.add(controller);
        controller.enqueue(sseEncoder.encode(": connected\n\n"));
      },
      cancel() {
        taskStreamClients.delete(ctrl);
      },
    });
    return new HttpResponse(stream, {
      headers: { "Content-Type": "text/event-stream" },
    });
  }),

  // GET /tasks/:taskId (openapi.yaml:815-830) — "Task with children
  // populated" (:826); the queue panel's expand fetch. After the
  // /tasks/stream handler so the static segment matches first.
  http.get(`${BASE}/tasks/:taskId`, ({ params }) => {
    const id = params.taskId as string;
    taskDetailRequests.push(id);
    const found = mockTasks.find((t) => t.id === id);
    if (!found) {
      return HttpResponse.json({ code: "not_found", message: "task not found" }, { status: 404 });
    }
    return HttpResponse.json({ ...found, children: found.children ?? [] });
  }),

  // POST /tasks/:taskId/retry-failed (openapi.yaml:849-865) — "Failed
  // children re-enqueued; parent task returned" (202, :858-861).
  http.post(`${BASE}/tasks/:taskId/retry-failed`, ({ params }) => {
    const id = params.taskId as string;
    retryFailedRequests.push(id);
    const found = mockTasks.find((t) => t.id === id);
    if (!found) {
      return HttpResponse.json({ code: "not_found", message: "task not found" }, { status: 404 });
    }
    let requeued = 0;
    for (const child of found.children ?? []) {
      if (child.status === "failed") {
        child.status = "queued";
        child.error = null;
        requeued += 1;
      }
    }
    if (requeued > 0) found.status = "running";
    const { children: _children, ...parent } = found;
    return HttpResponse.json(parent, { status: 202 });
  }),

  // DELETE /tasks/{taskId} — cancel; doubles as chat stop-generation
  // (openapi.yaml:832-847). Known queue fixtures cancel with cascade
  // ("cancels queued/running children"); other ids keep the synthetic
  // chat-task response (stop-generation tests).
  http.delete(`${BASE}/tasks/:taskId`, ({ params }) => {
    const id = params.taskId as string;
    cancelRequests.push(id);
    cancelledTasks.add(id);
    const found = mockTasks.find((t) => t.id === id);
    if (found) {
      if (found.status === "queued" || found.status === "running") found.status = "cancelled";
      for (const child of found.children ?? []) {
        if (child.status === "queued" || child.status === "running") child.status = "cancelled";
      }
      const { children: _children, ...task } = found;
      return HttpResponse.json(task);
    }
    const task: Task = {
      id,
      type: "chat",
      status: "cancelled",
      progress: { done: 0, total: 1 },
      created_at: new Date().toISOString(),
    };
    return HttpResponse.json(task);
  }),
];

export function resetTasks() {
  cancelRequests.length = 0;
  mockTasks.length = 0;
  mockTasks.push(...seedTasks());
  taskListRequests.length = 0;
  taskDetailRequests.length = 0;
  retryFailedRequests.length = 0;
}
