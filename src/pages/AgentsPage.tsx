import { useMemo, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Loader,
  Menu,
  Modal,
  NativeSelect,
  Stack,
  TagsInput,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { api } from "../api/client";
import type { Agent, AgentCreate } from "../api/types";
import { useAsync } from "../hooks/useAsync";
import { useApp } from "../AppContext";
import { TreeBranch, TreeNode } from "../components";

// Agent tree view — "home view is a static node-and-edge diagram of
// the agent hierarchy (root → sub-agents)" (feature-spec.md:24); node shows
// "agent name, live instruction version, tools attached (icons), enabled
// state" (feature-spec.md:25); "Node click → instruction editor ... add
// sub-agent" (feature-spec.md:26). Data: GET /agenttrees/{tree}/agents —
// "Flat list of agents with parent links" (openapi.yaml:188); POST creates
// with "live_version 0 until v1 is saved" (openapi.yaml:215).
// The AI New-agent wizard is Phase 3 (openapi.yaml:204-206) — plain form here.
// "View recent conversations" routes to /agents/{id}/conversations, a minimal
// GET /conversations?agent_id= listing (openapi.yaml:365-371).
//
// Editor split (UX polish, planned 2026-08-10): the editor route nests under
// this page (App.tsx) rather than sitting beside it, so a node click swaps
// only the right-hand Outlet — the tree, its scroll position, stay mounted.
// The open agent is read back out of the URL (not local state) so a reload
// or a direct link to /agents/{id}/editor lands on the same split.

export function AgentsPage() {
  const { tree } = useApp();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const selectedAgentId = pathname.match(/^\/agents\/([^/]+)\/editor$/)?.[1] ?? null;
  // Add-agent modal target: null = closed; parent null = new root
  // (openapi.yaml:1169 "null parent_id = new root").
  const [adding, setAdding] = useState<{ parent: Agent | null } | null>(null);

  const { data: agents, error, reload } = useAsync(() => api.agents(tree), [tree]);

  // Hierarchy from parent_id links; agents whose parent is missing render as
  // roots rather than vanishing.
  const { roots, childrenOf } = useMemo(() => {
    const list = agents ?? [];
    const ids = new Set(list.map((a) => a.id));
    const childrenOf = new Map<string, Agent[]>();
    const roots: Agent[] = [];
    for (const agent of list) {
      if (agent.parent_id !== null && ids.has(agent.parent_id)) {
        const siblings = childrenOf.get(agent.parent_id) ?? [];
        siblings.push(agent);
        childrenOf.set(agent.parent_id, siblings);
      } else {
        roots.push(agent);
      }
    }
    return { roots, childrenOf };
  }, [agents]);

  const create = async (body: AgentCreate) => {
    await api.createAgent(tree, body);
    setAdding(null);
    reload();
  };

  if (error) {
    return (
      <Alert color="red" title="Failed to load agents">
        {error.message}
      </Alert>
    );
  }
  if (agents === null) return <Loader size="sm" />;

  return (
    <Group align="flex-start" gap="md" wrap="nowrap">
      <Box style={{ flex: "0 0 340px", minWidth: 280 }}>
        <Stack gap="md">
          <Title order={3}>Agents</Title>
          {roots.length === 0 ? (
            <Stack gap="xs" align="flex-start">
              <Text size="sm" c="dimmed">
                No agents in this tree yet.
              </Text>
              <Button size="xs" onClick={() => setAdding({ parent: null })}>
                Add root agent
              </Button>
            </Stack>
          ) : (
            <div>
              {roots.map((agent) => (
                <AgentNode
                  key={agent.id}
                  agent={agent}
                  childrenOf={childrenOf}
                  selectedId={selectedAgentId}
                  onEdit={(a) => navigate(`/agents/${a.id}/editor`)}
                  onAddChild={(a) => setAdding({ parent: a })}
                  onConversations={(a) => navigate(`/agents/${a.id}/conversations`)}
                />
              ))}
            </div>
          )}
        </Stack>
        <Modal
          opened={adding !== null}
          onClose={() => setAdding(null)}
          title={
            adding?.parent ? `Add sub-agent under ${adding.parent.name}` : "Add root agent"
          }
        >
          {adding && (
            <AddAgentForm
              onSubmit={(values) =>
                void create({ ...values, parent_id: adding.parent?.id ?? null })
              }
            />
          )}
        </Modal>
      </Box>
      {/* Right panel: the instruction editor for whichever agent is open —
          a nested route (App.tsx), rendered here via Outlet, so this is the
          same page as the tree rather than a navigation away from it. */}
      <Box style={{ flex: 1, minWidth: 0 }}>
        {selectedAgentId ? (
          <Outlet />
        ) : (
          <Text size="sm" c="dimmed" mt={40} ta="center">
            Select an agent to edit its instructions.
          </Text>
        )}
      </Box>
    </Group>
  );
}

function AgentNode({
  agent,
  childrenOf,
  selectedId,
  onEdit,
  onAddChild,
  onConversations,
}: {
  agent: Agent;
  childrenOf: Map<string, Agent[]>;
  selectedId: string | null;
  onEdit: (agent: Agent) => void;
  onAddChild: (agent: Agent) => void;
  onConversations: (agent: Agent) => void;
}) {
  const kids = childrenOf.get(agent.id) ?? [];
  return (
    <div data-testid={`agent-${agent.id}`}>
      <TreeNode
        label={agent.name}
        dimmed={!agent.enabled}
        selected={agent.id === selectedId}
        onClick={() => onEdit(agent)}
        badges={
          <>
            {/* live_version 0 = created but no v1 saved yet (openapi.yaml:215) */}
            {agent.live_version > 0 ? (
              <Badge size="xs" variant="filled" color="violet">
                v{agent.live_version}
              </Badge>
            ) : (
              <Badge size="xs" variant="light" color="gray">
                no versions yet
              </Badge>
            )}
            {agent.tools.map((tool) => (
              <Badge key={tool} size="xs" variant="light" color="teal">
                &#x1F527; {tool}
              </Badge>
            ))}
            {!agent.enabled && (
              <Badge size="xs" variant="light" color="gray">
                disabled
              </Badge>
            )}
          </>
        }
        actions={
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label={`Actions for ${agent.name}`}
              >
                &#x22EF;
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item onClick={() => onEdit(agent)}>Edit instructions</Menu.Item>
              <Menu.Item onClick={() => onAddChild(agent)}>Add sub-agent</Menu.Item>
              <Menu.Item onClick={() => onConversations(agent)}>
                View recent conversations
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        }
      />
      {kids.length > 0 && (
        <TreeBranch>
          {kids.map((child) => (
            <AgentNode
              key={child.id}
              agent={child}
              childrenOf={childrenOf}
              selectedId={selectedId}
              onEdit={onEdit}
              onAddChild={onAddChild}
              onConversations={onConversations}
            />
          ))}
        </TreeBranch>
      )}
    </div>
  );
}

// AgentCreate form (openapi.yaml:1166-1179): name required, optional tools
// list, format text|yaml defaulting to text.
function AddAgentForm({
  onSubmit,
}: {
  onSubmit: (values: { name: string; tools: string[]; format: "text" | "yaml" }) => void;
}) {
  const [name, setName] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [format, setFormat] = useState<"text" | "yaml">("text");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSubmit({ name: name.trim(), tools, format });
      }}
    >
      <Stack gap="sm">
        <TextInput
          label="Name"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          data-autofocus
          required
        />
        <TagsInput
          label="Tools (optional)"
          value={tools}
          onChange={setTools}
          placeholder="Type a tool name, press Enter"
        />
        <NativeSelect
          label="Format"
          data={["text", "yaml"]}
          value={format}
          onChange={(e) => setFormat(e.currentTarget.value as "text" | "yaml")}
        />
        <Button type="submit" size="xs">
          Create
        </Button>
      </Stack>
    </form>
  );
}
