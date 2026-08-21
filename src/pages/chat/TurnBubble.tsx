import { useState, type RefObject } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  CloseButton,
  CopyButton,
  Group,
  Paper,
  Stack,
  Text,
  Textarea,
  Tooltip,
} from "@mantine/core";
import {
  IconActivity,
  IconCheck,
  IconCopy,
  IconGitFork,
  IconLayoutGrid,
  IconLink,
  IconThumbDown,
  IconThumbDownFilled,
  IconThumbUp,
  IconThumbUpFilled,
} from "@tabler/icons-react";
import type { Turn } from "../../api/types";
import { EnvelopeChip } from "../../components";
import { Markdown } from "../../lib/markdown";
import type { Rating } from "./types";

export function TurnBubble({
  turn,
  thumb,
  onRate,
  comment = null,
  commentOpen = false,
  onComment,
  onDismissComment,
  onFork,
  onTrace,
  onCollect,
  shareUrl,
  shareTarget = false,
  shareFlash = false,
  shareRef,
}: {
  turn: Turn;
  thumb?: Rating;
  onRate: (rating: Rating) => void;
  comment?: string | null;
  commentOpen?: boolean;
  onComment?: (text: string) => void;
  onDismissComment?: () => void;
  onFork?: () => void;
  onTrace?: () => void;
  onCollect?: () => void;
  shareUrl?: string;
  shareTarget?: boolean;
  shareFlash?: boolean;
  shareRef?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <Paper
      ref={shareRef}
      p="sm"
      radius="md"
      withBorder={turn.role === "assistant"}
      bg={turn.role === "user" ? "blue.0" : undefined}
      // The desktop indents (20% / 10%) cost ~80px of a 390px phone screen;
      // keep the left/right asymmetry that distinguishes the roles but shrink
      // it in portrait.
      ml={turn.role === "user" ? { base: "8%", sm: "20%" } : 0}
      mr={turn.role === "assistant" ? { base: "4%", sm: "10%" } : 0}
      // Share arrival marker: persistent left accent for the whole visit, plus
      // a ring that fades ~2.5s after landing.
      data-share-target={shareTarget ? "true" : undefined}
      style={{
        borderLeft: shareTarget ? "3px solid var(--mantine-color-blue-6)" : undefined,
        boxShadow: shareFlash && shareTarget ? "0 0 0 2px var(--mantine-color-blue-3)" : undefined,
        transition: "box-shadow 700ms ease",
        scrollMarginBlock: 16,
      }}
    >
      <Group justify="space-between" mb={4}>
        <Text size="xs" c="dimmed">
          {turn.author}
        </Text>
        {/* Envelope affordance. Every turn records its
            context (date, timezone, region) at generation. Sketch 01 shows no
            envelope UI, so the surface is deliberately minimal — a hover
            tooltip on the timestamp (dotted underline = discoverable), showing
            the EnvelopeChip the trace header reuses. */}
        <Tooltip label={<EnvelopeChip envelope={turn.envelope} />} p={4}>
          <Text
            size="xs"
            c="dimmed"
            style={{ cursor: "help", textDecoration: "underline dotted" }}
          >
            {new Date(turn.created_at).toLocaleString()}
          </Text>
        </Tooltip>
      </Group>
      {/* Stored attachments render as filename chips (Turn.attachments,
          openapi.yaml:1313-1315; url is null in Phase 1 so no link). */}
      {turn.attachments && turn.attachments.length > 0 && (
        <Group gap={4} mb={4}>
          {turn.attachments.map((a) => (
            <Badge key={a.id} variant="light" color="gray" radius="sm" tt="none">
              &#x1F4CE; {a.filename}
            </Badge>
          ))}
        </Group>
      )}
      {turn.role === "assistant" ? (
        <Markdown content={turn.content} />
      ) : (
        <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
          {turn.content}
        </Text>
      )}
      {/* Persistent action row, bottom-right per sketches/clean/01-chat.svg
          (👍👎⧉⑂⌁). "Per assistant turn: 👍 / 👎 / copy buttons"
          (feature-spec.md:11) — user turns carry no row. */}
      {turn.role === "assistant" && (
        <Group gap={4} justify="flex-end" mt={6}>
          <Tooltip label="Thumbs up" openDelay={300}>
            <ActionIcon
              size="sm"
              variant={thumb === "up" ? "light" : "subtle"}
              color={thumb === "up" ? "blue" : "gray"}
              aria-label="Thumbs up"
              aria-pressed={thumb === "up"}
              onClick={() => onRate("up")}
            >
              {thumb === "up" ? (
                <IconThumbUpFilled size={16} stroke={1.5} />
              ) : (
                <IconThumbUp size={16} stroke={1.5} />
              )}
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Thumbs down" openDelay={300}>
            <ActionIcon
              size="sm"
              variant={thumb === "down" ? "light" : "subtle"}
              color={thumb === "down" ? "blue" : "gray"}
              aria-label="Thumbs down"
              aria-pressed={thumb === "down"}
              onClick={() => onRate("down")}
            >
              {thumb === "down" ? (
                <IconThumbDownFilled size={16} stroke={1.5} />
              ) : (
                <IconThumbDown size={16} stroke={1.5} />
              )}
            </ActionIcon>
          </Tooltip>
          {/* "copy copies raw markdown" (feature-spec.md:272) — Turn.content,
              not the rendered HTML. */}
          <CopyButton value={turn.content} timeout={1500}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? "Copied message" : "Copy message"} openDelay={300}>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color={copied ? "teal" : "gray"}
                  aria-label={copied ? "Copied" : "Copy message"}
                  onClick={copy}
                >
                  {copied ? <IconCheck size={16} stroke={1.5} /> : <IconCopy size={16} stroke={1.5} />}
                </ActionIcon>
              </Tooltip>
            )}
          </CopyButton>
          {/* Link-copy sits next to copy because it is the same gesture (put
              something on the clipboard), keeping the row's copy affordances
              together and its density unchanged. */}
          {shareUrl && (
            <CopyButton value={shareUrl} timeout={1500}>
              {({ copied, copy }) => (
                <Tooltip label={copied ? "Link copied" : "Copy link to turn"} openDelay={300}>
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color={copied ? "teal" : "gray"}
                    aria-label={copied ? "Link copied" : "Copy link to turn"}
                    onClick={copy}
                  >
                    {copied ? <IconCheck size={16} stroke={1.5} /> : <IconLink size={16} stroke={1.5} />}
                  </ActionIcon>
                </Tooltip>
              )}
            </CopyButton>
          )}
          {/* Fork — sketch 01 tags this icon "POST …/replay/turn". */}
          {onFork && (
            <Tooltip label="Fork turn" openDelay={300}>
              <ActionIcon
                size="sm"
                variant="subtle"
                color="gray"
                aria-label="Fork turn"
                onClick={onFork}
              >
                <IconGitFork size={16} stroke={1.5} />
              </ActionIcon>
            </Tooltip>
          )}
          {/* Collect. One icon in the existing row (same size, same subtle
              variant), which is the whole point of "one keystroke". */}
          {onCollect && (
            <Tooltip label="Collect into eval benchmark" openDelay={300}>
              <ActionIcon
                size="sm"
                variant="subtle"
                color="gray"
                aria-label="Collect into eval benchmark"
                onClick={onCollect}
              >
                <IconLayoutGrid size={16} stroke={1.5} />
              </ActionIcon>
            </Tooltip>
          )}
          {/* "trace icon on every turn — in Chat, results grid cells, and
              drill-in" (feature-spec.md:141); routes to the trace view. */}
          {onTrace && (
            <Tooltip label="Open trace" openDelay={300}>
              <ActionIcon
                size="sm"
                variant="subtle"
                color="gray"
                aria-label="Open trace"
                onClick={onTrace}
              >
                <IconActivity size={16} stroke={1.5} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      )}
      {/* The note that came with the current thumb, rendered as a small quoted
          line under the turn it judges. It survives reload because it IS the
          judgment (Judgment.reasoning), refetched with the conversation's
          judgments; a receiver of a shared link sees it for the same reason,
          with no special-casing. */}
      {turn.role === "assistant" && comment && !commentOpen && (
        <Text
          size="xs"
          c="dimmed"
          mt={4}
          data-testid={`turn-comment-${turn.id}`}
          style={{
            borderLeft: "2px solid var(--mantine-color-gray-4)",
            paddingLeft: 8,
            whiteSpace: "pre-wrap",
          }}
        >
          {thumb === "up" ? "\u{1F44D}" : "\u{1F44E}"} {comment}
        </Text>
      )}
      {turn.role === "assistant" && commentOpen && onComment && (
        <FeedbackCommentBox
          rating={thumb}
          onSubmit={onComment}
          onDismiss={onDismissComment ?? (() => {})}
        />
      )}
    </Paper>
  );
}

// The "tell us more" box revealed by a thumb. Optional and dismissible: the
// rating is already saved by the time this renders, so closing it costs
// nothing. Its draft is LOCAL state so a keystroke re-renders this box only,
// not the transcript (same reasoning as the streaming draft store,
// docs/review-2026-08-05.md A8). Enter submits / Shift+Enter newlines,
// matching the composer's convention (feature-spec.md:12).
function FeedbackCommentBox({
  rating,
  onSubmit,
  onDismiss,
}: {
  rating?: Rating;
  onSubmit: (text: string) => void;
  onDismiss: () => void;
}) {
  const [text, setText] = useState("");
  const submit = () => {
    if (text.trim()) onSubmit(text);
  };
  return (
    <Stack gap={4} mt={6} data-testid="feedback-comment-box">
      <Group gap={6} wrap="nowrap" align="flex-end">
        <Textarea
          size="xs"
          style={{ flex: 1 }}
          autosize
          minRows={1}
          maxRows={4}
          autoFocus
          aria-label="Feedback comment"
          placeholder={rating === "up" ? "What made this good?" : "What went wrong?"}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Button size="compact-xs" onClick={submit} disabled={!text.trim()}>
          Send
        </Button>
        {/* Label deliberately avoids the words "feedback comment" — that is
            the textarea's accessible name, and a substring-matching locator
            (Playwright getByLabel) would otherwise resolve to both. */}
        <CloseButton size="sm" aria-label="Close comment box" onClick={onDismiss} />
      </Group>
    </Stack>
  );
}
