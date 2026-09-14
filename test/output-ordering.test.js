import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeThread, normalizeThreadList } from "../src/normalize.js";
import {
  formatListHuman,
  formatListJsonl,
  formatThreadHuman,
  jsonlRecordsForThread,
} from "../src/output.js";

const schemaPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "schemas",
  "jsonl-record.v1.json",
);
const jsonlSchema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));

function assertValidJsonlRecord(record) {
  for (const key of jsonlSchema.required) {
    assert.ok(Object.hasOwn(record, key), `missing required key "${key}"`);
  }
  assert.ok(
    jsonlSchema.properties.recordType.enum.includes(record.recordType),
    `unexpected recordType "${record.recordType}"`,
  );
  for (const key of Object.keys(record)) {
    assert.ok(Object.hasOwn(jsonlSchema.properties, key), `unexpected key "${key}"`);
  }
  assert.equal(typeof record.data, "object");
  assert.ok(record.data !== null);
}

function baseThread(overrides = {}) {
  return {
    schemaVersion: "t3-thread.thread.v1",
    toolVersion: "0.1.0",
    thread: {
      id: "sanitized-thread-0001",
      projectId: "sanitized-project-0001",
      title: "Sanitized thread",
      project: { title: "Sanitized project", workspaceRoot: "/sanitized/workspace" },
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:02:00.000Z",
      latestUserMessageAt: null,
      latestTurnId: null,
      runtimeMode: null,
      interactionMode: null,
      modelSelection: null,
      workspaceRoot: "/sanitized/workspace",
    },
    turns: [],
    messages: [],
    activities: [],
    provider: {
      providerName: "SanitizedProvider",
      providerSessionId: "sanitized-session-0001",
      providerThreadId: "sanitized-thread-0001",
      providerInstanceId: null,
      status: "idle",
      lastError: null,
      activeTurnId: null,
      runtimeMode: null,
      updatedAt: "2026-01-01T00:02:00.000Z",
    },
    warnings: [{ code: "MALFORMED_JSON", field: "thread.modelSelection", message: "bad json" }],
    ...overrides,
  };
}

function turn(id, { requestedAt = null, startedAt = null, completedAt = null, rowId = null } = {}) {
  return {
    rowId,
    threadId: "sanitized-thread-0001",
    turnId: id,
    pendingMessageId: null,
    sourceProposedPlanThreadId: null,
    sourceProposedPlanId: null,
    assistantMessageId: null,
    state: "completed",
    requestedAt,
    startedAt,
    completedAt,
    checkpointTurnCount: null,
    checkpointRef: null,
    checkpointStatus: null,
    checkpointFiles: null,
  };
}

function message(id, { createdAt = null, updatedAt = null } = {}) {
  return {
    messageId: id,
    threadId: "sanitized-thread-0001",
    turnId: null,
    role: "assistant",
    text: "sanitized text",
    isStreaming: false,
    createdAt,
    updatedAt,
    attachments: null,
  };
}

function activity(id, { createdAt = null, sequence = null } = {}) {
  return {
    activityId: id,
    threadId: "sanitized-thread-0001",
    turnId: null,
    tone: null,
    kind: "note",
    summary: "sanitized summary",
    payload: null,
    createdAt,
    sequence,
  };
}

test("first JSONL record is the thread header and carries provider and warnings", () => {
  const thread = baseThread();
  const records = jsonlRecordsForThread(thread);

  assert.equal(records[0].recordType, "thread");
  assert.equal(records[0].schemaVersion, "t3-thread.jsonl-record.v1");
  assert.equal(records[0].threadId, thread.thread.id);
  assert.deepEqual(records[0].data, thread.thread);
  assert.deepEqual(records[0].provider, thread.provider);
  assert.deepEqual(records[0].warnings, thread.warnings);
});

test("records after the header are emitted in chronological order across types", () => {
  const thread = baseThread({
    turns: [
      turn("turn-a", { requestedAt: "2026-01-01T00:00:01.000Z", rowId: 1 }),
      turn("turn-b", { requestedAt: "2026-01-01T00:01:00.000Z", rowId: 2 }),
    ],
    messages: [
      message("m1", { createdAt: "2026-01-01T00:01:00.000Z" }),
      message("m2", { createdAt: "2026-01-01T00:02:00.000Z" }),
    ],
    activities: [
      activity("a1", { createdAt: "2026-01-01T00:01:00.000Z", sequence: 1 }),
      activity("a2", { createdAt: "2026-01-01T00:02:00.000Z", sequence: 1 }),
    ],
  });

  const records = jsonlRecordsForThread(thread);

  assert.deepEqual(records.map((record) => record.recordType), [
    "thread",
    "turn",
    "turn",
    "message",
    "activity",
    "message",
    "activity",
  ]);
  assert.deepEqual(records.map((record) => record.data.turnId ?? record.data.messageId ?? record.data.activityId ?? record.data.id), [
    "sanitized-thread-0001",
    "turn-a",
    "turn-b",
    "m1",
    "a1",
    "m2",
    "a2",
  ]);
});

test("timestamp ties are broken by type rank, then secondary key, then identifier", () => {
  const tiedTimestamp = "2026-01-01T00:00:00.000Z";
  const buildThread = () => baseThread({
    turns: [
      turn("turn-e", { requestedAt: tiedTimestamp, rowId: 5 }),
      turn("turn-a", { requestedAt: tiedTimestamp, rowId: 1 }),
    ],
    messages: [
      message("msg-b", { createdAt: tiedTimestamp }),
      message("msg-a", { createdAt: tiedTimestamp }),
    ],
    activities: [
      activity("act-c", { createdAt: tiedTimestamp, sequence: 3 }),
      activity("act-a", { createdAt: tiedTimestamp, sequence: 1 }),
    ],
  });

  const expectedTypes = ["thread", "turn", "turn", "message", "message", "activity", "activity"];
  const expectedIds = [
    "sanitized-thread-0001",
    "turn-a",
    "turn-e",
    "msg-a",
    "msg-b",
    "act-a",
    "act-c",
  ];

  const first = jsonlRecordsForThread(buildThread());
  const second = jsonlRecordsForThread(buildThread());

  for (const records of [first, second]) {
    assert.deepEqual(records.map((record) => record.recordType), expectedTypes);
    assert.deepEqual(
      records.map((record) => record.data.turnId ?? record.data.messageId ?? record.data.activityId ?? record.data.id),
      expectedIds,
    );
  }
  assert.deepEqual(first, second);
});

test("null-timestamp records land last, ordered deterministically by identifier", () => {
  const thread = baseThread({
    turns: [
      turn("turn-t", { requestedAt: "2026-01-01T00:00:00.000Z", rowId: 1 }),
      turn("turn-null-b", {}),
      turn("turn-null-a", {}),
    ],
    messages: [message("msg-null", {})],
    activities: [activity("act-null", {})],
  });

  const records = jsonlRecordsForThread(thread);

  assert.deepEqual(records.map((record) => record.recordType), [
    "thread",
    "turn",
    "turn",
    "turn",
    "message",
    "activity",
  ]);
  assert.deepEqual(
    records.slice(1).map((record) => record.data.turnId ?? record.data.messageId ?? record.data.activityId),
    ["turn-t", "turn-null-a", "turn-null-b", "msg-null", "act-null"],
  );
});

test("every emitted record validates against the jsonl-record.v1 schema", () => {
  const thread = baseThread({
    turns: [turn("turn-a", { requestedAt: "2026-01-01T00:00:01.000Z", rowId: 1 })],
    messages: [message("m1", { createdAt: "2026-01-01T00:01:00.000Z" })],
    activities: [activity("a1", { createdAt: "2026-01-01T00:01:00.000Z", sequence: 1 })],
  });

  for (const record of jsonlRecordsForThread(thread)) {
    assertValidJsonlRecord(record);
  }
});

test("a bounded thread emits only its selected records plus the header", () => {
  const thread = baseThread({
    turns: [turn("turn-a", { requestedAt: "2026-01-01T00:00:01.000Z", rowId: 1 })],
    messages: [message("m1", { createdAt: "2026-01-01T00:00:02.000Z" })],
    activities: [],
    selection: {
      kind: "turn",
      turnId: "turn-a",
      turnLimit: null,
      turnOffset: null,
      totalTurns: 5,
      selectedTurnIds: ["turn-a"],
    },
  });

  const records = jsonlRecordsForThread(thread);

  assert.equal(records.length, 3);
  assert.deepEqual(records.map((record) => record.recordType), ["thread", "turn", "message"]);
});

test("formatThreadHuman marks bounded output as partial and unbounded output as complete", () => {
  const boundedThread = baseThread({
    turns: [turn("turn-a", { requestedAt: "2026-01-01T00:00:01.000Z", rowId: 1 })],
    messages: [],
    activities: [],
    warnings: [],
    selection: {
      kind: "turn-window",
      turnId: null,
      turnLimit: 1,
      turnOffset: 0,
      totalTurns: 5,
      selectedTurnIds: ["turn-a"],
    },
  });
  const unboundedThread = baseThread({ warnings: [] });

  const boundedOutput = formatThreadHuman(boundedThread);
  const unboundedOutput = formatThreadHuman(unboundedThread);

  assert.match(boundedOutput, /Partial history: yes/);
  assert.match(boundedOutput, /Turns \(partial\)/);
  assert.match(boundedOutput, /Messages \(partial\)/);
  assert.match(boundedOutput, /Activities \(partial\)/);
  assert.match(boundedOutput, /turn-a/);

  assert.doesNotMatch(unboundedOutput, /Partial history/);
  assert.doesNotMatch(unboundedOutput, /\(partial\)/);
});

function summaryRow(overrides = {}) {
  return {
    thread_id: "sanitized-thread-0001",
    project_id: "sanitized-project-0001",
    title: "Sanitized thread",
    project_join_id: "sanitized-project-0001",
    project_title: "Sanitized project",
    workspace_root: "/sanitized/workspace",
    branch: null,
    worktree_path: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:02:00.000Z",
    latest_user_message_at: null,
    latest_turn_id: null,
    ...overrides,
  };
}

test("normalizeThreadList builds the envelope with metadata-only summaries", () => {
  const rows = [
    summaryRow({ thread_id: "thread-1", updated_at: "2026-01-01T00:00:00.000Z" }),
    summaryRow({ thread_id: "thread-2", updated_at: "2026-01-01T00:01:00.000Z" }),
  ];

  const forward = normalizeThreadList(rows, {
    options: { project: "Sanitized project", since: null, before: null, limit: 50, offset: 0, reverse: false },
    hasMore: false,
  });

  assert.equal(forward.schemaVersion, "t3-thread.list.v1");
  assert.equal(forward.count, 2);
  assert.equal(forward.hasMore, false);
  assert.equal(forward.ordering.sortBy, "updatedAt");
  assert.equal(forward.ordering.direction, "asc");
  assert.deepEqual(forward.filters, { project: "Sanitized project", since: null, before: null });
  assert.equal(forward.limit, 50);
  assert.equal(forward.offset, 0);
  assert.equal(forward.threads.length, 2);
  for (const summary of forward.threads) {
    assert.equal(Object.hasOwn(summary, "text"), false);
    assert.equal(Object.hasOwn(summary, "messages"), false);
    assert.equal(Object.hasOwn(summary, "activities"), false);
  }

  const reverse = normalizeThreadList(rows, {
    options: { project: null, since: null, before: null, limit: 50, offset: 0, reverse: true },
    hasMore: true,
  });
  assert.equal(reverse.ordering.direction, "desc");
  assert.equal(reverse.hasMore, true);
});

test("formatListJsonl emits the list header followed by one thread record per row, or just the header when empty", () => {
  const rows = [
    summaryRow({ thread_id: "thread-1" }),
    summaryRow({ thread_id: "thread-2" }),
  ];
  const list = normalizeThreadList(rows, {
    options: { project: null, since: null, before: null, limit: 50, offset: 0, reverse: false },
    hasMore: false,
  });

  const lines = formatListJsonl(list).trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 3);
  assert.equal(lines[0].recordType, "list");
  assert.equal(lines[0].threadId, null);
  assert.deepEqual(lines[0].data, {
    filters: list.filters,
    ordering: list.ordering,
    limit: list.limit,
    offset: list.offset,
    count: list.count,
    hasMore: list.hasMore,
  });
  assert.equal(lines[1].recordType, "thread");
  assert.equal(lines[1].threadId, "thread-1");
  assert.equal(lines[2].threadId, "thread-2");

  const emptyList = normalizeThreadList([], {
    options: { project: null, since: null, before: null, limit: 50, offset: 0, reverse: false },
    hasMore: false,
  });
  const emptyLines = formatListJsonl(emptyList).trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.equal(emptyLines.length, 1);
  assert.equal(emptyLines[0].recordType, "list");
});

test("formatListHuman renders the filter block and reports no matching threads when empty", () => {
  const emptyList = normalizeThreadList([], {
    options: { project: "CodeLaunch", since: null, before: null, limit: 50, offset: 0, reverse: false },
    hasMore: false,
  });

  const output = formatListHuman(emptyList);
  assert.match(output, /^Threads\n=======\n/);
  assert.match(output, /Project: CodeLaunch/);
  assert.match(output, /Since: -/);
  assert.match(output, /Before: -/);
  assert.match(output, /Order: updatedAt asc/);
  assert.match(output, /Limit: 50/);
  assert.match(output, /Offset: 0/);
  assert.match(output, /Returned: 0/);
  assert.match(output, /More available: no/);
  assert.match(output, /No matching threads\./);

  const populatedList = normalizeThreadList([summaryRow({ thread_id: "thread-1" })], {
    options: { project: null, since: null, before: null, limit: 50, offset: 0, reverse: false },
    hasMore: false,
  });
  const populatedOutput = formatListHuman(populatedList);
  assert.match(populatedOutput, /Sanitized thread/);
  assert.match(populatedOutput, /ID: thread-1/);
});

function threadRows(overrides = {}) {
  return {
    thread: {
      thread_id: "sanitized-thread-0001",
      project_id: "sanitized-project-0001",
      title: "Sanitized thread",
      project_join_id: "sanitized-project-0001",
      project_title: "Sanitized project",
      workspace_root: "/sanitized/workspace",
      branch: null,
      worktree_path: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:02:00.000Z",
      latest_turn_id: null,
      latest_user_message_at: null,
      runtime_mode: null,
      interaction_mode: null,
      model_selection_json: null,
    },
    turns: [],
    messages: [],
    activities: [],
    provider: {
      provider_name: "SanitizedProvider",
      provider_session_id: "sanitized-session-0001",
      provider_thread_id: "sanitized-thread-0001",
      provider_instance_id: null,
      status: "idle",
      last_error: null,
      active_turn_id: null,
      runtime_mode: null,
      updated_at: "2026-01-01T00:02:00.000Z",
    },
    ...overrides,
  };
}

test("normalizeThread without a selection option has no selection key", () => {
  const result = normalizeThread(threadRows());
  assert.equal(Object.hasOwn(result, "selection"), false);
});

test("normalizeThread with a selection option adds the selection metadata", () => {
  const rows = threadRows({
    turns: [
      {
        row_id: 1,
        thread_id: "sanitized-thread-0001",
        turn_id: "turn-a",
        state: "completed",
        requested_at: "2026-01-01T00:00:01.000Z",
      },
    ],
  });

  const result = normalizeThread(rows, {
    selection: { kind: "turn", turnId: "turn-a", totalTurns: 5 },
  });

  assert.deepEqual(result.selection, {
    kind: "turn",
    turnId: "turn-a",
    turnLimit: null,
    turnOffset: null,
    totalTurns: 5,
    selectedTurnIds: ["turn-a"],
  });
});
