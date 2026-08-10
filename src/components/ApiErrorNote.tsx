import { List, Text } from "@mantine/core";
import { ApiError } from "../api/client";

// The machine-readable half of an error, made readable (openapi.yaml Error).
//
// Two things the message alone cannot carry. `details[]` names the input that
// was rejected, so "Something went wrong" becomes "items[2].kind: unknown
// kind" — the difference between a user guessing and a user fixing. And
// `request_id` is what a support ticket quotes: without it the only thing a
// user can report is the same sentence the server already forgot.
//
// Renders NOTHING for a plain Error or for an ApiError with neither — most
// 404s have nothing to point at, and an empty "Reference:" line would be
// clutter on the commonest failure there is.
export function ApiErrorNote({ error }: { error: unknown }) {
  if (!(error instanceof ApiError)) return null;
  const { details, requestId } = error;
  if (details.length === 0 && !requestId) return null;
  return (
    <>
      {details.length > 0 && (
        <List size="xs" mt={4} data-testid="error-details">
          {details.map((d, i) => (
            <List.Item key={`${d.field ?? d.row ?? i}`}>
              {[d.field, d.row != null ? `row ${d.row}` : null].filter(Boolean).join(", ")}
              {d.field || d.row != null ? ": " : ""}
              {d.message}
            </List.Item>
          ))}
        </List>
      )}
      {requestId && (
        <Text size="xs" c="dimmed" mt={4} data-testid="error-request-id">
          Reference: {requestId}
        </Text>
      )}
    </>
  );
}

/** The human half — the one sentence, whatever the thrown value turned out to be. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Something went wrong.";
}
