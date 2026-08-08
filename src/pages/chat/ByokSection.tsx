import { useEffect, useState, useSyncExternalStore } from "react";
import { Badge, Button, Divider, Group, PasswordInput, Select, Text } from "@mantine/core";
import { api } from "../../api/client";
import { getLlmKey, getLlmModel, setLlmKey, setLlmModel } from "../../api/llmKey";
import type { Model } from "../../api/types";

// "Live LLM (BYOK)". Not a chat setting: chat settings are session values the
// page spreads into each ChatRequest body, whereas this is a credential that
// lives in the browser's localStorage ONLY (docs/deployment.md:25) and rides
// as X-LLM-Key/X-LLM-Model headers the api client attaches centrally — never
// in URLs, never logged (docs/deployment.md:26-27).

// llmKey.ts is the single store, so nothing here keeps a copy of the key:
// components read it while rendering and this revision counter only tells them
// WHEN to read again. They need telling because the two surfaces sit in
// different subtrees — the header badge stays mounted for the whole visit
// while the section is torn down every time the settings popover closes — and
// they must never disagree about whether a key is active.
let revision = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const getRevision = () => revision;
const publish = () => {
  revision += 1;
  for (const listener of listeners) listener();
};

function useLlmKey() {
  useSyncExternalStore(subscribe, getRevision);
  return { key: getLlmKey(), model: getLlmModel() };
}

// The curated list survives a popover close, keyed by the key it was fetched
// with: the section remounts on every open and must not refetch each time.
let modelCache: { key: string; models: Model[] } | null = null;

// Visible "live" indicator while a BYOK key is active — generation is going to
// a real provider, not the canned mock (docs/deployment.md:24-27 requires it
// near the settings gear).
export function ByokLiveBadge() {
  const { key } = useLlmKey();
  if (!key) return null;
  return (
    <Badge size="xs" color="green" variant="light" data-testid="live-badge">
      live
    </Badge>
  );
}

export function ByokSection() {
  const { key, model } = useLlmKey();
  const [keyDraft, setKeyDraft] = useState("");
  const [models, setModels] = useState<Model[] | null>(() =>
    key && modelCache?.key === key ? modelCache.models : null,
  );

  // GET /models WITH the key header answers the curated live list ("populated
  // from a curated cheap-model list in live mode", docs/deployment.md:22-23);
  // the client attaches the header once the key is stored.
  useEffect(() => {
    if (!key || modelCache?.key === key) return;
    let cancelled = false;
    api
      .models()
      .then((list) => {
        modelCache = { key, models: list };
        if (!cancelled) setModels(list);
      })
      .catch(() => {
        if (!cancelled) setModels(null);
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  const saveKey = () => {
    const next = keyDraft.trim();
    if (!next) return;
    modelCache = null; // a new key gets its own curated list
    setLlmKey(next); // localStorage only (docs/deployment.md:25)
    setKeyDraft("");
    publish();
  };
  const clearKey = () => {
    setLlmKey(null);
    setLlmModel(null);
    modelCache = null;
    setModels(null);
    publish();
  };
  const pickModel = (value: string | null) => {
    setLlmModel(value);
    publish();
  };

  return (
    <>
      <Divider label="Live LLM (BYOK)" labelPosition="left" my={2} />
      {key ? (
        <>
          <Group gap={6} wrap="nowrap">
            <Text size="xs" c="dimmed" style={{ flex: 1 }}>
              OpenRouter key active (stored in this browser only).
            </Text>
            <Button size="xs" color="red" variant="light" onClick={clearKey}>
              Clear key
            </Button>
          </Group>
          <Select
            label="Live model"
            placeholder="Provider default"
            data={models?.map((m) => ({ value: m.id, label: m.name })) ?? []}
            value={model}
            onChange={pickModel}
            clearable
            comboboxProps={{ withinPortal: false }}
          />
        </>
      ) : (
        <>
          <PasswordInput
            label="OpenRouter key"
            placeholder="sk-or-…"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.currentTarget.value)}
          />
          <Button size="xs" variant="default" onClick={saveKey} disabled={!keyDraft.trim()}>
            Save key
          </Button>
        </>
      )}
    </>
  );
}
