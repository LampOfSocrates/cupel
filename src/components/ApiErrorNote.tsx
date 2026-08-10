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

/**
 * The heading a failure deserves. A 403 is not a fault — it is an ANSWER: the
 * server understood the request and the caller is not allowed to make it
 * (openapi.yaml responses.Forbidden, whose message names the permission and
 * the tree). Titling it "Error" told the user their save had broken; titling
 * it "Not permitted" tells them the truth, and the server's own sentence below
 * says which permission on which tree.
 *
 * Deliberately keyed on the STATUS, not on a code: the contract answers one
 * `forbidden` for a missing role and for a missing per-tree permission alike,
 * because the machine-readable half is the operation's own `x-requires`
 * declaration, not a second discriminator in the body.
 */
export function errorTitle(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.status === 403 ? "Not permitted" : fallback;
}

/** The human half — the one sentence, whatever the thrown value turned out to be. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Something went wrong.";
}
