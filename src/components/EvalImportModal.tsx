import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  FileInput,
  Group,
  Loader,
  Modal,
  Radio,
  ScrollArea,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { api } from "../api/client";
import { useQueue } from "../QueueContext";
import type { EvalCaseImportReport, EvalSet } from "../api/types";

// Bulk import — "upload CSV/XLSX (or paste a table) with columns mapped
// to input/output/reference → creates/extends a set in one shot
// (POST /eval/cases/import, queued for large files; row errors reported per
// line, not all-or-nothing)" (feature-spec.md:63).
//
// Column mapping: the contract's `mapping` is a JSON object naming the
// columns that feed input/output/reference (openapi.yaml:1409-1414), so the
// picker needs the file's header. For CSV we read the first line locally to
// offer real column names; for XLSX (a zip, not readable without a parser we
// deliberately do not ship to the browser) the same three fields fall back to
// free text — the server answers 422 naming the header if a column is wrong
// (mock/main.py import handler), so a typo is a clear message, never a silent
// half-import.
//
// Two response paths, one report shape: 200 renders the report inline; 202
// hands back a TaskRef and the report arrives on the task
// (openapi.yaml:1386-1389 "result.import_report carries the identical report
// shape"). The 202 path is read off the app-wide queue (QueueContext), the
// same store the queue panel and sidebar badge use — no second poller.

interface Props {
  opened: boolean;
  sets: EvalSet[];
  onClose: () => void;
  /** Fired once cases actually landed, so the workbench refetches. */
  onImported: () => void;
}

type Target = "none" | "new" | "existing";

// Header sniff for CSV only — quoted commas are handled, everything else is
// left to the server's real parser (mock/tabular.py).
function parseCsvHeader(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cell.trim());
      cell = "";
    } else cell += ch;
  }
  out.push(cell.trim());
  return out.filter(Boolean);
}

export function ImportReportView({ report }: { report: EvalCaseImportReport }) {
  return (
    <Stack gap={6} data-testid="import-report">
      <Group gap="xs">
        <Badge variant="light" color={report.rows_imported > 0 ? "teal" : "gray"}>
          {report.rows_imported} / {report.rows_total} rows imported
        </Badge>
        {report.errors.length > 0 && (
          <Badge variant="light" color="red">
            {report.errors.length} row {report.errors.length === 1 ? "error" : "errors"}
          </Badge>
        )}
        {report.set_id && (
          <Badge variant="light" color="blue">
            set {report.set_id}
          </Badge>
        )}
      </Group>
      {report.errors.length > 0 && (
        <ScrollArea.Autosize mah={220}>
          <Table striped withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Row</Table.Th>
                <Table.Th>Column</Table.Th>
                <Table.Th>Problem</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {report.errors.map((e, i) => (
                <Table.Tr key={`${e.row}-${i}`}>
                  <Table.Td>{e.row}</Table.Td>
                  <Table.Td>{e.field ?? "—"}</Table.Td>
                  <Table.Td>{e.message}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea.Autosize>
      )}
      {report.errors.length === 0 && (
        <Text size="xs" c="dimmed">
          Every row imported cleanly.
        </Text>
      )}
    </Stack>
  );
}

// Fresh form per open WITHOUT a reset effect: Mantine's Modal does not render
// its children while closed (ModalBaseContent is a Transition mounted on
// `opened`), so the body mounts on open and its state — file, mapping, report,
// watched task id — starts at the initialisers every time. That is what the old
// `if (opened) return; …` teardown effect was for.
export function EvalImportModal({ opened, sets, onClose, onImported }: Props) {
  return (
    <Modal opened={opened} onClose={onClose} title="Import eval cases" size="lg">
      <ImportBody sets={sets} onClose={onClose} onImported={onImported} />
    </Modal>
  );
}

function ImportBody({ sets, onClose, onImported }: Omit<Props, "opened">) {
  const { tasks } = useQueue();
  const [file, setFile] = useState<File | null>(null);
  const [columns, setColumns] = useState<string[] | null>(null);
  const [mapping, setMapping] = useState({ input: "", output: "", reference: "" });
  const [target, setTarget] = useState<Target>("none");
  const [setName, setSetName] = useState("");
  const [setId, setSetId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<EvalCaseImportReport | null>(null);
  const [queuedTaskId, setQueuedTaskId] = useState<string | null>(null);

  // 202 path: the report lands on the task, watched through the app-wide
  // queue store (openapi.yaml:2795-2802).
  const queuedTask = queuedTaskId ? tasks.find((t) => t.id === queuedTaskId) : undefined;
  const queuedReport = queuedTask?.result?.import_report ?? null;
  useEffect(() => {
    if (queuedReport) onImported();
    // onImported is a stable refetch callback from the page.
  }, [queuedReport, onImported]);

  async function pickFile(next: File | null) {
    setFile(next);
    setColumns(null);
    setReport(null);
    setError(null);
    if (!next) return;
    if (!next.name.toLowerCase().endsWith(".csv")) return;
    try {
      const text = await next.text();
      const header = parseCsvHeader(text.split(/\r?\n/)[0] ?? "");
      if (header.length) {
        setColumns(header);
        setMapping({
          input: header[0] ?? "",
          output: header[1] ?? "",
          reference: header[2] ?? "",
        });
      }
    } catch {
      // Unreadable locally is not fatal — the server parses the real file.
    }
  }

  const canSubmit = Boolean(file) && Boolean(mapping.input) && Boolean(mapping.output) && !busy;

  async function submit() {
    if (!file) return;
    setBusy(true);
    setError(null);
    setReport(null);
    setQueuedTaskId(null);
    try {
      const result = await api.importEvalCases(
        file,
        {
          input: mapping.input,
          output: mapping.output,
          ...(mapping.reference ? { reference: mapping.reference } : {}),
        },
        target === "new" && setName
          ? { set_name: setName }
          : target === "existing" && setId
            ? { set_id: setId }
            : undefined,
      );
      if (result.status === 200) {
        setReport(result.report);
        onImported();
      } else {
        setQueuedTaskId(result.task.task_id);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const field = (key: "input" | "output" | "reference", label: string, required: boolean) =>
    columns ? (
      <Select
        key={key}
        size="xs"
        label={label}
        required={required}
        clearable={!required}
        data={columns}
        value={mapping[key] || null}
        onChange={(v) => setMapping((m) => ({ ...m, [key]: v ?? "" }))}
      />
    ) : (
      <TextInput
        key={key}
        size="xs"
        label={label}
        required={required}
        placeholder="column name"
        value={mapping[key]}
        onChange={(e) => {
          const value = e.currentTarget.value;
          setMapping((m) => ({ ...m, [key]: value }));
        }}
      />
    );

  const setOptions = useMemo(
    () => sets.map((s) => ({ value: s.id, label: `${s.name} v${s.version}` })),
    [sets],
  );

return (
  <Stack gap="sm">
      <FileInput
        size="xs"
        label="Spreadsheet"
        description="CSV or XLSX — one row per case. Paste a table by saving it as CSV."
        placeholder="Choose a file"
        accept=".csv,.xlsx,text/csv"
        value={file}
        onChange={pickFile}
      />
      <Text size="xs" c="dimmed">
        Map the file's columns onto the case fields. Reference is optional —
        reference-free rubrics are allowed.
      </Text>
      <Group grow align="flex-start">
        {field("input", "Input (prompt)", true)}
        {field("output", "Output (candidate)", true)}
        {field("reference", "Reference (expected)", false)}
      </Group>
      {!columns && file && (
        <Text size="xs" c="dimmed">
          Column names could not be read from this file — type them exactly as
          they appear in the header row.
        </Text>
      )}
      <Radio.Group
        size="xs"
        label="Add the imported cases to a set"
        value={target}
        onChange={(v) => setTarget(v as Target)}
      >
        <Group gap="md" mt={4}>
          <Radio value="none" label="No set" />
          <Radio value="new" label="New set" />
          <Radio value="existing" label="Existing set" disabled={sets.length === 0} />
        </Group>
      </Radio.Group>
      {target === "new" && (
        <TextInput
          size="xs"
          label="New set name"
          value={setName}
          onChange={(e) => setSetName(e.currentTarget.value)}
        />
      )}
      {target === "existing" && (
        <Select
          size="xs"
          label="Set to extend"
          description="Extending appends a new membership version."
          data={setOptions}
          value={setId}
          onChange={setSetId}
        />
      )}
      {error && (
        <Alert color="red" title="Import failed">
          {error}
        </Alert>
      )}
      {queuedTaskId && !queuedReport && (
        <Group gap="xs">
          <Loader size="xs" />
          <Text size="xs">
            Large file — queued as task {queuedTaskId}. The report appears here when it
            finishes; the Queue panel tracks it meanwhile.
          </Text>
        </Group>
      )}
      {(report ?? queuedReport) && <ImportReportView report={(report ?? queuedReport)!} />}
      <Group justify="flex-end">
        <Button size="xs" variant="default" onClick={onClose}>
          Close
        </Button>
        <Button size="xs" onClick={submit} disabled={!canSubmit} loading={busy}>
          Import
        </Button>
      </Group>
    </Stack>
  );
}
