import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A dedicated database, not a mutation of createFixtureDatabase(), because the doctor-count
// assertions in sqlite-store.test.js and cli.test.js pin that fixture's row counts exactly.

export const FLAT_THREAD_ID = "participant-flat-thread";
export const TREE_THREAD_ID = "participant-tree-thread";
export const BROKEN_THREAD_ID = "participant-broken-thread";
export const EMPTY_THREAD_ID = "participant-empty-thread";
export const DELETED_THREAD_ID = "participant-deleted-thread";
export const CYCLE_SCOPE_THREAD_ID = "participant-cycle-scope-thread";
export const SELF_PARENT_THREAD_ID = "participant-self-parent-thread";
export const USAGE_FOLD_THREAD_ID = "participant-usage-fold-thread";
export const TYPE_COERCION_THREAD_ID = "participant-type-coercion-thread";

function taskPayload(values) {
  return JSON.stringify(values);
}

// Shared with the local fixture builders in participants.test.js, which need the same
// projection schema against their own standalone databases.
export const PROJECTION_SCHEMA_SQL = `
    CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY,
      title TEXT,
      workspace_root TEXT
    );
    CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT,
      branch TEXT,
      worktree_path TEXT,
      latest_turn_id TEXT,
      created_at TEXT,
      updated_at TEXT,
      latest_user_message_at TEXT,
      deleted_at TEXT,
      runtime_mode TEXT,
      interaction_mode TEXT,
      model_selection_json TEXT
    );
    CREATE TABLE projection_thread_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT,
      turn_id TEXT,
      role TEXT,
      text TEXT,
      is_streaming INTEGER,
      created_at TEXT,
      updated_at TEXT,
      attachments_json TEXT
    );
    CREATE TABLE projection_thread_activities (
      activity_id TEXT PRIMARY KEY,
      thread_id TEXT,
      turn_id TEXT,
      tone TEXT,
      kind TEXT,
      summary TEXT,
      payload_json TEXT,
      created_at TEXT,
      sequence INTEGER
    );
    CREATE TABLE projection_thread_sessions (
      thread_id TEXT PRIMARY KEY,
      provider_name TEXT,
      provider_session_id TEXT,
      provider_thread_id TEXT,
      provider_instance_id TEXT,
      status TEXT,
      last_error TEXT
    );
    CREATE TABLE projection_turns (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT,
      turn_id TEXT,
      pending_message_id TEXT,
      source_proposed_plan_thread_id TEXT,
      source_proposed_plan_id TEXT,
      assistant_message_id TEXT,
      state TEXT,
      requested_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      checkpoint_turn_count INTEGER,
      checkpoint_ref TEXT,
      checkpoint_status TEXT,
      checkpoint_files_json TEXT
    );
  `;

// Also shared with participants.test.js's local fixture builders: the turn and activity
// insert statements are identical across every projection fixture in this repo.
export function prepareTurnInsert(database) {
  return database.prepare(`
    INSERT INTO projection_turns (
      thread_id, turn_id, pending_message_id, source_proposed_plan_thread_id,
      source_proposed_plan_id, assistant_message_id, state, requested_at, started_at,
      completed_at, checkpoint_turn_count, checkpoint_ref, checkpoint_status,
      checkpoint_files_json
    ) VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
  `);
}

export function prepareActivityInsert(database) {
  return database.prepare(`
    INSERT INTO projection_thread_activities (
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence
    ) VALUES (?, ?, ?, 'info', ?, NULL, ?, ?, ?)
  `);
}

export function createParticipantFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-thread-participants-"));
  const databasePath = path.join(directory, "state.sqlite");
  const database = new DatabaseSync(databasePath);

  database.exec(PROJECTION_SCHEMA_SQL);

  database
    .prepare("INSERT INTO projection_projects (project_id, title, workspace_root) VALUES (?, ?, ?)")
    .run("participant-project", "Participant project", "/tmp/participant-workspace");

  const thread = database.prepare(`
    INSERT INTO projection_threads (
      thread_id, project_id, title, branch, worktree_path, latest_turn_id,
      created_at, updated_at, latest_user_message_at, deleted_at, runtime_mode,
      interaction_mode, model_selection_json
    ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, NULL, ?, NULL, NULL, NULL)
  `);
  thread.run(FLAT_THREAD_ID, "participant-project", "Flat participants", "pturn-2",
    "2026-03-01T00:00:00.000Z", "2026-03-01T01:00:00.000Z", null);
  thread.run(TREE_THREAD_ID, "participant-project", "Explicit hierarchy", "tturn-1",
    "2026-03-02T00:00:00.000Z", "2026-03-02T01:00:00.000Z", null);
  thread.run(BROKEN_THREAD_ID, "participant-project", "Unresolved and cyclic parents", "bturn-1",
    "2026-03-03T00:00:00.000Z", "2026-03-03T01:00:00.000Z", null);
  thread.run(EMPTY_THREAD_ID, "participant-project", "No task activities", null,
    "2026-03-04T00:00:00.000Z", "2026-03-04T01:00:00.000Z", null);
  thread.run(DELETED_THREAD_ID, "participant-project", "Deleted thread", null,
    "2026-03-05T00:00:00.000Z", "2026-03-05T01:00:00.000Z", "2026-03-05T02:00:00.000Z");
  thread.run(CYCLE_SCOPE_THREAD_ID, "participant-project", "Cycle scope", null,
    "2026-03-06T00:00:00.000Z", "2026-03-06T01:00:00.000Z", null);
  thread.run(SELF_PARENT_THREAD_ID, "participant-project", "Self parent", null,
    "2026-03-07T00:00:00.000Z", "2026-03-07T01:00:00.000Z", null);
  thread.run(USAGE_FOLD_THREAD_ID, "participant-project", "Usage folded per field", null,
    "2026-03-08T00:00:00.000Z", "2026-03-08T01:00:00.000Z", null);
  thread.run(TYPE_COERCION_THREAD_ID, "participant-project", "Field and identifier typing", null,
    "2026-03-09T00:00:00.000Z", "2026-03-09T01:00:00.000Z", null);

  const turn = prepareTurnInsert(database);
  turn.run(FLAT_THREAD_ID, "pturn-1", "completed",
    "2026-03-01T00:00:10.000Z", "2026-03-01T00:00:11.000Z", "2026-03-01T00:00:59.000Z");
  turn.run(FLAT_THREAD_ID, "pturn-2", "completed",
    "2026-03-01T00:10:00.000Z", "2026-03-01T00:10:01.000Z", "2026-03-01T00:10:59.000Z");
  turn.run(TREE_THREAD_ID, "tturn-1", "completed",
    "2026-03-02T00:00:10.000Z", "2026-03-02T00:00:11.000Z", "2026-03-02T00:00:59.000Z");
  turn.run(BROKEN_THREAD_ID, "bturn-1", "completed",
    "2026-03-03T00:00:10.000Z", "2026-03-03T00:00:11.000Z", "2026-03-03T00:00:59.000Z");
  turn.run(CYCLE_SCOPE_THREAD_ID, "csturn-1", "completed",
    "2026-03-04T00:00:10.000Z", "2026-03-04T00:00:11.000Z", "2026-03-04T00:00:59.000Z");
  turn.run(SELF_PARENT_THREAD_ID, "spturn-1", "completed",
    "2026-03-05T00:00:10.000Z", "2026-03-05T00:00:11.000Z", "2026-03-05T00:00:59.000Z");
  turn.run(USAGE_FOLD_THREAD_ID, "ufturn-1", "completed",
    "2026-03-06T00:00:10.000Z", "2026-03-06T00:00:11.000Z", "2026-03-06T00:00:59.000Z");
  turn.run(TYPE_COERCION_THREAD_ID, "tcturn-1", "completed",
    "2026-03-07T00:00:10.000Z", "2026-03-07T00:00:11.000Z", "2026-03-07T00:00:59.000Z");

  const activity = prepareActivityInsert(database);

  // Flat thread: two independent tasks in turn 1 that are adjacent in time and sequence with
  // no parentAgentId, plus a later task in turn 2. Adjacency must never become hierarchy.
  activity.run("pa-1", FLAT_THREAD_ID, "pturn-1", "task.started", taskPayload({
    taskId: "task-alpha", title: "Alpha task", role: "general-purpose", model: "model-a",
    agentKind: "agent", taskType: "local_agent", effort: "high", toolUseId: "tool-use-alpha",
  }), "2026-03-01T00:00:20.000Z", 1);
  activity.run("pa-2", FLAT_THREAD_ID, "pturn-1", "task.started", taskPayload({
    taskId: "task-beta", title: "Beta task", role: "Explore", model: "model-b",
    agentKind: "agent", taskType: "local_agent",
  }), "2026-03-01T00:00:21.000Z", 2);
  // A later progress row omits model/role: last-non-null-wins must not erase them.
  activity.run("pa-3", FLAT_THREAD_ID, "pturn-1", "task.progress", taskPayload({
    taskId: "task-alpha", lastToolName: "Read", detail: "working",
    usage: { total_tokens: 1200, tool_uses: 4, duration_ms: 5000 },
  }), "2026-03-01T00:00:30.000Z", 3);
  activity.run("pa-4", FLAT_THREAD_ID, "pturn-1", "task.completed", taskPayload({
    taskId: "task-alpha", status: "completed", summary: "Alpha done",
    typedUsage: { totalTokens: 1500, toolUses: 5, durationMs: 6000 },
    outputFile: "/tmp/alpha.out", phaseIndex: 2, runHandles: { runId: "run-1" },
  }), "2026-03-01T00:00:40.000Z", 4);
  // Beta never reports a status at all.
  activity.run("pa-5", FLAT_THREAD_ID, "pturn-1", "task.progress", taskPayload({
    taskId: "task-beta", lastToolName: "Grep",
  }), "2026-03-01T00:00:41.000Z", 5);
  // Gamma reports an unrecognised status, which must stay non-terminal.
  activity.run("pa-6", FLAT_THREAD_ID, "pturn-2", "task.started", taskPayload({
    taskId: "task-gamma", title: "Gamma task", role: "Plan",
  }), "2026-03-01T00:10:20.000Z", 6);
  activity.run("pa-7", FLAT_THREAD_ID, "pturn-2", "task.updated", taskPayload({
    taskId: "task-gamma", status: "gremlin", isBackgrounded: true,
  }), "2026-03-01T00:10:30.000Z", 7);
  // Non-task activities in the same thread must be ignored entirely.
  activity.run("pa-8", FLAT_THREAD_ID, "pturn-1", "tool.started", taskPayload({
    itemType: "dynamic_tool_call", data: { toolName: "Read", input: { taskId: "task-alpha" } },
  }), "2026-03-01T00:00:25.000Z", 8);
  activity.run("pa-9", FLAT_THREAD_ID, "pturn-1", "context-window.updated", taskPayload({
    detail: "irrelevant",
  }), "2026-03-01T00:00:26.000Z", 9);

  // Tree thread: an explicit three-level chain, plus two siblings under the root and a task
  // with a null created_at that must sort last.
  activity.run("ta-1", TREE_THREAD_ID, "tturn-1", "task.started", taskPayload({
    taskId: "root-task", title: "Root", role: "general-purpose",
  }), "2026-03-02T00:00:20.000Z", 1);
  activity.run("ta-2", TREE_THREAD_ID, "tturn-1", "task.started", taskPayload({
    taskId: "child-task", title: "Child", parentAgentId: "root-task", agentIndex: 0,
  }), "2026-03-02T00:00:21.000Z", 2);
  activity.run("ta-3", TREE_THREAD_ID, "tturn-1", "task.started", taskPayload({
    taskId: "grandchild-task", title: "Grandchild", parentAgentId: "child-task",
  }), "2026-03-02T00:00:22.000Z", 3);
  activity.run("ta-4", TREE_THREAD_ID, "tturn-1", "task.started", taskPayload({
    taskId: "second-child-task", title: "Second child", parentAgentId: "root-task",
  }), "2026-03-02T00:00:23.000Z", 4);
  activity.run("ta-5", TREE_THREAD_ID, "tturn-1", "task.started", taskPayload({
    taskId: "null-time-task", title: "No timestamp",
  }), null, 5);

  // Broken thread: an unresolved parent, and a two-node cycle.
  activity.run("ba-1", BROKEN_THREAD_ID, "bturn-1", "task.started", taskPayload({
    taskId: "orphan-task", title: "Orphan", parentAgentId: "missing-parent-task",
  }), "2026-03-03T00:00:20.000Z", 1);
  activity.run("ba-2", BROKEN_THREAD_ID, "bturn-1", "task.started", taskPayload({
    taskId: "cycle-a", title: "Cycle A", parentAgentId: "cycle-b",
  }), "2026-03-03T00:00:21.000Z", 2);
  activity.run("ba-3", BROKEN_THREAD_ID, "bturn-1", "task.started", taskPayload({
    taskId: "cycle-b", title: "Cycle B", parentAgentId: "cycle-a",
  }), "2026-03-03T00:00:22.000Z", 3);
  // Two tasks sharing a firstSeenAt exercise the taskId tie-breaker.
  activity.run("ba-4", BROKEN_THREAD_ID, "bturn-1", "task.started", taskPayload({
    taskId: "tie-b-task", title: "Tie B",
  }), "2026-03-03T00:00:30.000Z", 4);
  activity.run("ba-5", BROKEN_THREAD_ID, "bturn-1", "task.started", taskPayload({
    taskId: "tie-a-task", title: "Tie A",
  }), "2026-03-03T00:00:30.000Z", 5);
  // Malformed payload and a payload with no taskId are both skipped without throwing.
  activity.run("ba-6", BROKEN_THREAD_ID, "bturn-1", "task.progress", "not-json",
    "2026-03-03T00:00:31.000Z", 6);
  activity.run("ba-7", BROKEN_THREAD_ID, "bturn-1", "task.progress", taskPayload({
    title: "No task id",
  }), "2026-03-03T00:00:32.000Z", 7);

  activity.run("da-1", DELETED_THREAD_ID, null, "task.started", taskPayload({
    taskId: "deleted-thread-task", title: "Deleted",
  }), "2026-03-05T00:00:20.000Z", 1);

  // Cycle-scope thread: A and B form a two-node cycle. C's parentAgentId is A, so C sits
  // downstream of the cycle without being a member of it -- only A and B may be swept into
  // PARENT_CYCLE. D has no parent and is an unrelated root.
  activity.run("cs-1", CYCLE_SCOPE_THREAD_ID, "csturn-1", "task.started", taskPayload({
    taskId: "A", parentAgentId: "B",
  }), "2026-03-06T00:00:20.000Z", 1);
  activity.run("cs-2", CYCLE_SCOPE_THREAD_ID, "csturn-1", "task.started", taskPayload({
    taskId: "B", parentAgentId: "A",
  }), "2026-03-06T00:00:21.000Z", 2);
  activity.run("cs-3", CYCLE_SCOPE_THREAD_ID, "csturn-1", "task.started", taskPayload({
    taskId: "C", parentAgentId: "A",
  }), "2026-03-06T00:00:22.000Z", 3);
  activity.run("cs-4", CYCLE_SCOPE_THREAD_ID, "csturn-1", "task.started", taskPayload({
    taskId: "D",
  }), "2026-03-06T00:00:23.000Z", 4);

  // Self-parent thread: a task whose parentAgentId is its own taskId. The identifier
  // resolves (it names a real participant), so this is a one-node PARENT_CYCLE, not an
  // UNRESOLVED_PARENT.
  activity.run("sp-1", SELF_PARENT_THREAD_ID, "spturn-1", "task.started", taskPayload({
    taskId: "self-parent-task", parentAgentId: "self-parent-task",
  }), "2026-03-07T00:00:20.000Z", 1);

  // Usage-fold thread: usage is merged per field, not as a whole object, and typedUsage
  // always wins over usage for a field regardless of which activity reported which.
  activity.run("uf-1", USAGE_FOLD_THREAD_ID, "ufturn-1", "task.started", taskPayload({
    taskId: "usage-fold-typed",
    typedUsage: { totalTokens: 100, toolUses: 5, durationMs: 20 },
  }), "2026-03-08T00:00:20.000Z", 1);
  activity.run("uf-2", USAGE_FOLD_THREAD_ID, "ufturn-1", "task.progress", taskPayload({
    taskId: "usage-fold-typed", typedUsage: { totalTokens: 200 },
  }), "2026-03-08T00:00:21.000Z", 2);
  activity.run("uf-3", USAGE_FOLD_THREAD_ID, "ufturn-1", "task.started", taskPayload({
    taskId: "usage-fold-snake",
    usage: { total_tokens: 100, tool_uses: 5, duration_ms: 20 },
  }), "2026-03-08T00:00:22.000Z", 3);
  activity.run("uf-4", USAGE_FOLD_THREAD_ID, "ufturn-1", "task.progress", taskPayload({
    taskId: "usage-fold-snake", usage: { total_tokens: 200 },
  }), "2026-03-08T00:00:23.000Z", 4);
  // usage (snake_case) arrives first here and typedUsage second, to prove typedUsage still
  // wins per field no matter which activity came later.
  activity.run("uf-5", USAGE_FOLD_THREAD_ID, "ufturn-1", "task.started", taskPayload({
    taskId: "usage-fold-mixed",
    usage: { total_tokens: 50, tool_uses: 1, duration_ms: 10 },
  }), "2026-03-08T00:00:24.000Z", 5);
  activity.run("uf-6", USAGE_FOLD_THREAD_ID, "ufturn-1", "task.progress", taskPayload({
    taskId: "usage-fold-mixed", typedUsage: { totalTokens: 999 },
  }), "2026-03-08T00:00:25.000Z", 6);

  // Type-coercion thread: a numeric taskId and a numeric parentAgentId that must still
  // resolve against it, plus wrong-typed scalars that must be routed to adapterSpecific
  // instead of breaking the schema, plus a legitimate isBackgrounded: false to prove that
  // path still preserves a real boolean.
  activity.run("tc-1", TYPE_COERCION_THREAD_ID, "tcturn-1", "task.started", taskPayload({
    taskId: 42, title: "Numeric id root",
  }), "2026-03-09T00:00:20.000Z", 1);
  activity.run("tc-2", TYPE_COERCION_THREAD_ID, "tcturn-1", "task.started", taskPayload({
    taskId: "numeric-id-child", parentAgentId: 42,
  }), "2026-03-09T00:00:21.000Z", 2);
  activity.run("tc-3", TYPE_COERCION_THREAD_ID, "tcturn-1", "task.started", taskPayload({
    taskId: "wrong-typed-task", status: 0, title: { a: 1 }, isBackgrounded: "yes",
  }), "2026-03-09T00:00:22.000Z", 3);
  activity.run("tc-4", TYPE_COERCION_THREAD_ID, "tcturn-1", "task.started", taskPayload({
    taskId: "bool-false-task", isBackgrounded: false,
  }), "2026-03-09T00:00:23.000Z", 4);

  database
    .prepare(`
      INSERT INTO projection_thread_sessions (
        thread_id, provider_name, provider_session_id, provider_thread_id,
        provider_instance_id, status, last_error
      ) VALUES (?, 'SanitizedProvider', NULL, NULL, NULL, 'ready', NULL)
    `)
    .run(FLAT_THREAD_ID);

  database.close();
  return { directory, databasePath };
}
