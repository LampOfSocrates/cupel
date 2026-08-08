import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
} from "react";
import {
  ActionIcon,
  CloseButton,
  FileButton,
  Group,
  Loader,
  Paper,
  Text,
  Textarea,
} from "@mantine/core";
import { api } from "../../api/client";
import type { Attachment } from "../../api/types";
import { formatBytes } from "../../lib/formatBytes";

// One composer chip per picked file. Files upload immediately on pick
// ("multipart upload to /upload before send", feature-spec.md:277); a 413/415
// leaves the chip in state "error" with the server's message and its file is
// never referenced in ChatRequest.attachments ("the UI surfaces the message",
// openapi.yaml:535-536).
interface PendingUpload {
  key: number;
  filename: string;
  size: number;
  status: "uploading" | "done" | "error";
  attachment?: Attachment; // set when status === "done"
  error?: string; // server message when status === "error"
  previewUrl?: string; // object URL for image/* (client-side only — url is null in Phase 1, openapi.yaml:1284)
}

// The input row and everything that feeds it: the draft text, picked/dropped/
// pasted files and their uploads. All of it is local — the page only learns
// about a message when it is sent.
export function Composer({
  streaming,
  canStop,
  onStop,
  onSend,
  resetToken,
}: {
  streaming: boolean;
  canStop: boolean;
  onStop: () => void;
  onSend: (text: string, attachments: Attachment[]) => void;
  // Bumped by the page when it leaves a conversation: chips belong to the
  // transcript they were picked for.
  resetToken: number;
}) {
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const pendingKeyRef = useRef(0);

  const uploading = pending.some((p) => p.status === "uploading");

  // Attach flow: picker, drag-drop or paste → immediate POST /upload per file
  // ("multipart upload to /upload before send", feature-spec.md:277). Chips
  // are removable before send (feature-spec.md:12 "attachment chips,
  // removable before send").
  const addFiles = (files: File[]) => {
    for (const file of files) {
      const key = ++pendingKeyRef.current;
      // Tiny client-side thumbnail for images; guarded because jsdom lacks
      // createObjectURL. Contract url stays null in Phase 1 (openapi.yaml:1284).
      const previewUrl =
        file.type.startsWith("image/") && typeof URL.createObjectURL === "function"
          ? URL.createObjectURL(file)
          : undefined;
      setPending((prev) => [
        ...prev,
        { key, filename: file.name, size: file.size, status: "uploading", previewUrl },
      ]);
      api
        .upload(file)
        .then((attachment) => {
          setPending((prev) =>
            prev.map((p) => (p.key === key ? { ...p, status: "done", attachment } : p)),
          );
        })
        .catch((e: unknown) => {
          // 413/oversize etc: surface the server's message on the chip; the
          // file is not added (openapi.yaml:535-536).
          const message = e instanceof Error ? e.message : String(e);
          setPending((prev) =>
            prev.map((p) => (p.key === key ? { ...p, status: "error", error: message } : p)),
          );
        });
    }
  };

  // Clipboard files go through addFiles above — the SAME path the picker and
  // drag-drop use, so chips, the 413 message and the send gate all behave
  // identically. A pasted screenshot arrives with a generic or empty name
  // ("image.png" on Chromium, "" elsewhere), which would render a blank chip
  // and store a blank filename, so those get a generated one.
  const pasteCountRef = useRef(0);
  const namePasted = (file: File): File => {
    if (file.name && !/^image\.[a-z0-9]+$/i.test(file.name)) return file;
    const ext = (file.type.split("/")[1] ?? "").replace(/[^a-z0-9]/gi, "") || "png";
    return new File([file], `pasted-image-${++pasteCountRef.current}.${ext}`, {
      type: file.type || "application/octet-stream",
      lastModified: file.lastModified,
    });
  };
  const pasteFiles = (e: ReactClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    // Text pastes are untouched: no preventDefault, so the textarea inserts
    // the text exactly as it does today.
    if (files.length === 0) return;
    e.preventDefault();
    addFiles(files.map(namePasted));
  };

  const removePending = (key: number) => {
    setPending((prev) => {
      const found = prev.find((p) => p.key === key);
      if (found?.previewUrl) URL.revokeObjectURL(found.previewUrl);
      return prev.filter((p) => p.key !== key);
    });
  };

  const clearPending = () => {
    setPending((prev) => {
      for (const p of prev) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
      return [];
    });
  };

  useEffect(() => {
    setPending((prev) => {
      if (prev.length === 0) return prev;
      for (const p of prev) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
      return [];
    });
  }, [resetToken]);

  // Unmount cleanup releases the image previews still held by chips: they are
  // revoked on remove, on send and on conversation switch, but leaving the
  // page mid-compose leaked one blob per picked image
  // (docs/review-2026-08-05.md A7). The ref is synced in an effect rather than
  // during render so the cleanup sees the last committed chips without a
  // render-phase write.
  const pendingRef = useRef<PendingUpload[]>([]);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);
  useEffect(
    () => () => {
      for (const p of pendingRef.current) {
        if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
      }
    },
    [],
  );

  const submit = () => {
    const text = input.trim();
    // Design choice: send is DISABLED until in-flight uploads settle (rather
    // than queued) — the spec sequences "upload to /upload before send"
    // (feature-spec.md:277) and disabling is the simplest state users can see.
    if (!text || streaming || uploading) return;
    // Only successfully uploaded files go out (openapi.yaml:1423 "Attachment
    // ids from POST /upload"); error chips are dropped with the rest on send.
    const uploaded = pending
      .filter((p) => p.status === "done" && p.attachment)
      .map((p) => p.attachment!);
    setInput("");
    clearPending();
    onSend(text, uploaded);
  };

  return (
    // Composer per sketches/clean/01-chat.svg: pending chips row
    // ("📎 spec.pdf ✕") above the input row "+ Message… ↑"; stop replaces send
    // in the same slot while streaming. Enter = send, Shift+Enter = newline
    // (feature-spec.md:12). Drag-drop uses native handlers — no dropzone
    // dependency is installed (package.json has no @mantine/dropzone).
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {pending.length > 0 && (
        <Group gap={6} mb={6} data-testid="pending-attachments">
          {pending.map((p) => (
            <Paper
              key={p.key}
              px={8}
              py={2}
              radius="sm"
              withBorder
              style={p.status === "error" ? { borderColor: "var(--mantine-color-red-6)" } : undefined}
            >
              <Group gap={6} wrap="nowrap">
                {p.previewUrl ? (
                  <img
                    src={p.previewUrl}
                    alt=""
                    height={18}
                    style={{ borderRadius: 3, maxWidth: 32, objectFit: "cover" }}
                  />
                ) : (
                  <Text size="xs">&#x1F4CE;</Text>
                )}
                <Text size="xs" c={p.status === "error" ? "red" : undefined}>
                  {p.filename} ({formatBytes(p.size)})
                </Text>
                {p.status === "uploading" && <Loader size={12} data-testid="chip-uploading" />}
                {p.status === "error" && (
                  <Text size="xs" c="red">
                    {p.error}
                  </Text>
                )}
                <CloseButton
                  size="xs"
                  aria-label={`Remove ${p.filename}`}
                  onClick={() => removePending(p.key)}
                />
              </Group>
            </Paper>
          ))}
        </Group>
      )}
      <Group align="flex-end" gap="xs">
        <FileButton multiple onChange={addFiles} inputProps={{ "aria-label": "Attach files input" }}>
          {({ onClick }) => (
            <ActionIcon
              size="lg"
              variant="default"
              aria-label="Attach files"
              onClick={onClick}
            >
              +
            </ActionIcon>
          )}
        </FileButton>
        <Textarea
          placeholder="Message…"
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          // Paste images/files straight into the composer; text pastes fall
          // through untouched.
          onPaste={pasteFiles}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          autosize
          minRows={1}
          maxRows={6}
          style={{ flex: 1 }}
        />
        {streaming ? (
          <ActionIcon
            size="lg"
            variant="filled"
            color="red"
            aria-label="Stop generation"
            onClick={onStop}
            disabled={!canStop}
          >
            &#x25A0;
          </ActionIcon>
        ) : (
          <ActionIcon
            size="lg"
            variant="filled"
            aria-label="Send"
            onClick={submit}
            disabled={!input.trim() || uploading}
          >
            &#x2191;
          </ActionIcon>
        )}
      </Group>
    </div>
  );
}
