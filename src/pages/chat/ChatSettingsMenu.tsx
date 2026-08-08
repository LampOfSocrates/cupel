import { useState, type Dispatch, type SetStateAction } from "react";
import {
  ActionIcon,
  Button,
  Group,
  Indicator,
  NumberInput,
  Popover,
  Select,
  Stack,
  Text,
  Textarea,
} from "@mantine/core";
import { useApp } from "../../AppContext";
import { ByokLiveBadge, ByokSection } from "./ByokSection";
import type { ChatSettings } from "./types";

// Chat settings submenu. "Chat has its own Settings submenu (model,
// temperature, system prompt — session-scoped)" (feature-spec.md:7); "sent
// with each /chat call" (feature-spec.md:278). Model options from GET /models
// (feature-spec.md:122), fetched once on first open and cached in AppContext.
// Placement per the sketches' chat header (title left, "⚙" top-right;
// annotated 01-chat.svg shows a "model · temp" summary beside the gear — we
// render that summary only when settings deviate from defaults, doubling as
// the visible "custom settings active" indication alongside the dot badge).
// The annotated sketch tags this "GET/PUT /settings", but /settings is
// deferred (openapi.yaml:38-40) — the values stay in React state only: they
// persist across conversation switches within the session, not across
// reloads. Unset = absent key = omitted from ChatRequest.
export function ChatSettingsMenu({
  settings: chatSettings,
  onChange: setChatSettings,
}: {
  settings: ChatSettings;
  onChange: Dispatch<SetStateAction<ChatSettings>>;
}) {
  const { models, ensureModels } = useApp();
  const [opened, setOpened] = useState(false);
  // NumberInput emits partial strings mid-typing ("0.") — keep the raw value
  // locally so typing isn't clobbered; only committed numbers reach settings.
  const [tempRaw, setTempRaw] = useState<number | string>(chatSettings.temperature ?? "");

  const dirty = Object.values(chatSettings).some((v) => v !== undefined);
  const patch = (p: Partial<ChatSettings>) =>
    setChatSettings((prev) => {
      const next = { ...prev, ...p };
      for (const k of Object.keys(next) as (keyof ChatSettings)[]) {
        if (next[k] === undefined) delete next[k];
      }
      return next;
    });
  const reset = () => {
    setChatSettings({});
    setTempRaw("");
  };

  const modelName =
    models?.find((m) => m.id === chatSettings.model)?.name ?? chatSettings.model;
  const summary = [
    modelName,
    chatSettings.temperature !== undefined ? `temp ${chatSettings.temperature}` : undefined,
    chatSettings.system_prompt !== undefined ? "sys prompt" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Group gap={6} wrap="nowrap">
      {dirty && (
        <Text size="xs" c="dimmed" data-testid="chat-settings-summary">
          {summary}
        </Text>
      )}
      <ByokLiveBadge />
      <Popover opened={opened} onChange={setOpened} position="bottom-end" shadow="md">
        <Popover.Target>
          <Indicator disabled={!dirty} color="blue" size={8} offset={2}>
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label="Chat settings"
              onClick={() => {
                ensureModels();
                setTempRaw(chatSettings.temperature ?? "");
                setOpened((o) => !o);
              }}
            >
              &#x2699;
            </ActionIcon>
          </Indicator>
        </Popover.Target>
        <Popover.Dropdown>
          <Stack gap="xs" w={260}>
            {/* Model dropdown fed by GET /models (feature-spec.md:122);
                clearable back to the backend default. Combobox kept inside
                the popover DOM so option clicks don't count as outside. */}
            <Select
              label="Model"
              placeholder="Default"
              data={models?.map((m) => ({ value: m.id, label: m.name })) ?? []}
              value={chatSettings.model ?? null}
              onChange={(value) => patch({ model: value ?? undefined })}
              clearable
              comboboxProps={{ withinPortal: false }}
            />
            {/* Number input over slider: the sketch header is dense and a
                slider cannot represent "unset"; bounds 0-2, empty = unset. */}
            <NumberInput
              label="Temperature"
              placeholder="Default"
              min={0}
              max={2}
              step={0.1}
              decimalScale={2}
              value={tempRaw}
              onChange={(value) => {
                setTempRaw(value);
                patch({ temperature: typeof value === "number" ? value : undefined });
              }}
            />
            <Textarea
              label="System prompt"
              placeholder="Default"
              autosize
              minRows={2}
              maxRows={6}
              value={chatSettings.system_prompt ?? ""}
              onChange={(e) =>
                patch({ system_prompt: e.currentTarget.value || undefined })
              }
            />
            <Button variant="default" size="xs" onClick={reset} disabled={!dirty}>
              Reset to defaults
            </Button>
            {/* The BYOK key is not a chat setting — it owns its own state and
                store; it renders here only because the gear is the one
                affordance the header has room for. */}
            <ByokSection />
          </Stack>
        </Popover.Dropdown>
      </Popover>
    </Group>
  );
}
