import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createT3ThreadClient, EXIT_CODES, ThreadNotFoundError } from "../src/index.js";
import {
  isTerminalTaskStatus,
  normalizeParticipants,
  TASK_ACTIVITY_KINDS,
  TERMINAL_TASK_STATUSES,
} from "../src/participants.js";
import {
  BROKEN_THREAD_ID,
  createParticipantFixture,
  CYCLE_SCOPE_THREAD_ID,
  DELETED_THREAD_ID,
  EMPTY_THREAD_ID,
  FLAT_THREAD_ID,
  prepareActivityInsert,
  prepareTurnInsert,
  PROJECTION_SCHEMA_SQL,
  SELF_PARENT_THREAD_ID,
  TREE_THREAD_ID,
  TYPE_COERCION_THREAD_ID,
  USAGE_FOLD_THREAD_ID,
} from "./fixtures/participant-fixture.js";
import { assertMatchesSchema as assertSchema } from "./fixtures/schema-assert.js";

const schemaPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "schemas",
  "participants.v1.json",
);
const participantsSchema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));

function cleanupFixture(fixture) {
  fs.rmSync(fixture.directory, { recursive: true, force: true });
}

// A standalone database (not test/fixtures/participant-fixture.js), scoped to
// PARENT_OUT_OF_SELECTION: a parent whose own activities live in a turn outside the read
// window, versus a parent that is genuinely absent from the thread. Two threads share this
// database so each scenario gets its own turn selection without cross-contaminating warnings.
const TURN_SCOPED_THREAD_ID = "participant-turn-scoped-thread";
const TURN_SCOPED_TURN_1 = "tsturn-1";
const TURN_SCOPED_TURN_2 = "tsturn-2";
const TURN_SCOPED_GHOST_THREAD_ID = "participant-turn-scoped-ghost-thread";
const TURN_SCOPED_GHOST_TURN = "tsgturn-1";

// A standalone database, scoped to coverage gaps 4 and 5: isBackgrounded folded across
// multiple activities for one task (not just a single-activity type check), and turnId keeping
// the first non-null turn_id across activities rather than the last.
const FOLD_THREAD_ID = "participant-fold-across-activities-thread";
const FOLD_COMMON_TURN = "cafturn-1";
const FOLD_TURN_A = "cafturn-a";
const FOLD_TURN_B = "cafturn-b";

function createTurnScopedFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-thread-turn-scoped-"));
  const databasePath = path.join(directory, "state.sqlite");
  const database = new DatabaseSync(databasePath);

  database.exec(PROJECTION_SCHEMA_SQL);

  const thread = database.prepare(`
    INSERT INTO projection_threads (
      thread_id, project_id, title, branch, worktree_path, latest_turn_id,
      created_at, updated_at, latest_user_message_at, deleted_at, runtime_mode,
      interaction_mode, model_selection_json
    ) VALUES (?, NULL, ?, NULL, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)
  `);
  thread.run(TURN_SCOPED_THREAD_ID, "Turn-scoped parent", TURN_SCOPED_TURN_2,
    "2026-04-01T00:00:00.000Z", "2026-04-01T00:20:00.000Z");
  thread.run(TURN_SCOPED_GHOST_THREAD_ID, "Genuinely missing parent", TURN_SCOPED_GHOST_TURN,
    "2026-04-02T00:00:00.000Z", "2026-04-02T00:20:00.000Z");

  const turn = prepareTurnInsert(database);
  turn.run(TURN_SCOPED_THREAD_ID, TURN_SCOPED_TURN_1, "completed",
    "2026-04-01T00:00:10.000Z", "2026-04-01T00:00:11.000Z", "2026-04-01T00:00:59.000Z");
  turn.run(TURN_SCOPED_THREAD_ID, TURN_SCOPED_TURN_2, "completed",
    "2026-04-01T00:10:10.000Z", "2026-04-01T00:10:11.000Z", "2026-04-01T00:10:59.000Z");
  turn.run(TURN_SCOPED_GHOST_THREAD_ID, TURN_SCOPED_GHOST_TURN, "completed",
    "2026-04-02T00:00:10.000Z", "2026-04-02T00:00:11.000Z", "2026-04-02T00:00:59.000Z");

  const activity = prepareActivityInsert(database);

  // task A works only in T1; task B's only activity is in T2 and names A as its parent. A
  // selection over T2 alone never sees A's own activity.
  activity.run("tsa-1", TURN_SCOPED_THREAD_ID, TURN_SCOPED_TURN_1, "task.started", JSON.stringify({
    taskId: "turn-scoped-a", title: "Parent task",
  }), "2026-04-01T00:00:20.000Z", 1);
  activity.run("tsa-2", TURN_SCOPED_THREAD_ID, TURN_SCOPED_TURN_2, "task.started", JSON.stringify({
    taskId: "turn-scoped-b", title: "Child task", parentAgentId: "turn-scoped-a",
  }), "2026-04-01T00:10:20.000Z", 2);

  // task C names a parent that never appears anywhere in the thread, in or out of the
  // selected turn -- the genuinely unresolvable case a turn-scoped read must still catch.
  activity.run("tsg-1", TURN_SCOPED_GHOST_THREAD_ID, TURN_SCOPED_GHOST_TURN, "task.started",
    JSON.stringify({ taskId: "turn-scoped-c", title: "Orphan under selection", parentAgentId: "turn-scoped-ghost" }),
    "2026-04-02T00:00:20.000Z", 1);

  database.close();
  return { directory, databasePath };
}

function createFoldAcrossActivitiesFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-thread-fold-across-"));
  const databasePath = path.join(directory, "state.sqlite");
  const database = new DatabaseSync(databasePath);

  database.exec(PROJECTION_SCHEMA_SQL);

  const thread = database.prepare(`
    INSERT INTO projection_threads (
      thread_id, project_id, title, branch, worktree_path, latest_turn_id,
      created_at, updated_at, latest_user_message_at, deleted_at, runtime_mode,
      interaction_mode, model_selection_json
    ) VALUES (?, NULL, ?, NULL, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)
  `);
  thread.run(FOLD_THREAD_ID, "Fold across activities", FOLD_TURN_B,
    "2026-05-01T00:00:00.000Z", "2026-05-01T00:20:00.000Z");

  const turn = prepareTurnInsert(database);
  turn.run(FOLD_THREAD_ID, FOLD_COMMON_TURN, "completed",
    "2026-05-01T00:00:10.000Z", "2026-05-01T00:00:11.000Z", "2026-05-01T00:00:59.000Z");
  turn.run(FOLD_THREAD_ID, FOLD_TURN_A, "completed",
    "2026-05-01T00:05:10.000Z", "2026-05-01T00:05:11.000Z", "2026-05-01T00:05:59.000Z");
  turn.run(FOLD_THREAD_ID, FOLD_TURN_B, "completed",
    "2026-05-01T00:10:10.000Z", "2026-05-01T00:10:11.000Z", "2026-05-01T00:10:59.000Z");

  const activity = prepareActivityInsert(database);

  // isBackgrounded folded across activities, not just type-checked within one: true then a
  // later false must fold to false -- the later non-null value wins, and false is not treated
  // as absent.
  activity.run("caf-1", FOLD_THREAD_ID, FOLD_COMMON_TURN, "task.started", JSON.stringify({
    taskId: "fold-bool-true-then-false", isBackgrounded: true,
  }), "2026-05-01T00:00:20.000Z", 1);
  activity.run("caf-2", FOLD_THREAD_ID, FOLD_COMMON_TURN, "task.progress", JSON.stringify({
    taskId: "fold-bool-true-then-false", isBackgrounded: false,
  }), "2026-05-01T00:00:21.000Z", 2);

  // false must survive a later activity that omits the field entirely: last-non-null-wins
  // means "no value reported in this activity", not "revert to null".
  activity.run("caf-3", FOLD_THREAD_ID, FOLD_COMMON_TURN, "task.started", JSON.stringify({
    taskId: "fold-bool-false-then-omitted", isBackgrounded: false,
  }), "2026-05-01T00:00:22.000Z", 3);
  activity.run("caf-4", FOLD_THREAD_ID, FOLD_COMMON_TURN, "task.progress", JSON.stringify({
    taskId: "fold-bool-false-then-omitted", lastToolName: "Grep",
  }), "2026-05-01T00:00:23.000Z", 4);

  // A wrong-typed value reported after a real boolean must not overwrite it.
  activity.run("caf-5", FOLD_THREAD_ID, FOLD_COMMON_TURN, "task.started", JSON.stringify({
    taskId: "fold-bool-true-then-wrong-typed", isBackgrounded: true,
  }), "2026-05-01T00:00:24.000Z", 5);
  activity.run("caf-6", FOLD_THREAD_ID, FOLD_COMMON_TURN, "task.progress", JSON.stringify({
    taskId: "fold-bool-true-then-wrong-typed", isBackgrounded: "yes",
  }), "2026-05-01T00:00:25.000Z", 6);

  // turnId keeps the first non-null turn_id: an early activity names no turn, and two later
  // activities in different, distinct turns follow. First-non-null-wins must resolve to
  // FOLD_TURN_A, not FOLD_TURN_B (last-non-null-wins) and not null (literal turn of the
  // earliest contributing activity).
  activity.run("caf-7", FOLD_THREAD_ID, null, "task.started", JSON.stringify({
    taskId: "fold-turn-null-then-two-real", title: "untagged start",
  }), "2026-05-01T00:00:26.000Z", 7);
  activity.run("caf-8", FOLD_THREAD_ID, FOLD_TURN_A, "task.progress", JSON.stringify({
    taskId: "fold-turn-null-then-two-real", detail: "first tagged turn",
  }), "2026-05-01T00:05:20.000Z", 8);
  activity.run("caf-9", FOLD_THREAD_ID, FOLD_TURN_B, "task.completed", JSON.stringify({
    taskId: "fold-turn-null-then-two-real", status: "completed",
  }), "2026-05-01T00:10:20.000Z", 9);

  database.close();
  return { directory, databasePath };
}

function byTaskId(view, taskId) {
  const found = view.participants.find((participant) => participant.taskId === taskId);
  assert.ok(found, `expected a participant for taskId "${taskId}"`);
  return found;
}

function assertValidParticipant(participant, participantSchema) {
  assertSchema(participant, participantSchema, participantsSchema, "participant");
}

function assertValidEnvelope(envelope) {
  assertSchema(envelope, participantsSchema, participantsSchema, "envelope");
}

// Guards the validator itself. Without this, a weakened assertValidEnvelope would silently
// stop protecting every other test that relies on it.
test("the envelope validator rejects the schema violations it exists to catch", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const valid = await client.listParticipants(FLAT_THREAD_ID);
    assertValidEnvelope(valid);

    const mutations = {
      "non-string taskId": (envelope) => {
        envelope.participants[0].taskId = 42;
      },
      "undeclared key inside usage": (envelope) => {
        envelope.participants[0].usage.cacheReads = 1;
      },
      "non-integer depth": (envelope) => {
        envelope.participants[0].depth = 1.5;
      },
      "warning missing its required message": (envelope) => {
        envelope.warnings.push({ code: "PARENT_CYCLE" });
      },
      "wrong schemaVersion": (envelope) => {
        envelope.schemaVersion = "t3-thread.participants.v2";
      },
      "ordering.direction outside the enum": (envelope) => {
        envelope.ordering.direction = "sideways";
      },
      "non-boolean hierarchyAvailable": (envelope) => {
        envelope.hierarchyAvailable = "true";
      },
      "non-string threadId": (envelope) => {
        envelope.threadId = 12345;
      },
      "non-string toolVersion": (envelope) => {
        envelope.toolVersion = 2;
      },
      "negative depth below the declared minimum": (envelope) => {
        envelope.participants[0].depth = -5;
      },
      "non-string element inside turnIds": (envelope) => {
        envelope.participants[0].turnIds = [42];
      },
      "selection replaced by an array": (envelope) => {
        envelope.selection = ["nope"];
      },
      "selection.kind outside the enum": (envelope) => {
        envelope.selection = { kind: "not-a-real-kind" };
      },
      "non-string selection.turnId": (envelope) => {
        envelope.selection = { kind: "turn", turnId: 42 };
      },
      "unexpected key at envelope level": (envelope) => {
        envelope.surprise = true;
      },
    };

    for (const [label, mutate] of Object.entries(mutations)) {
      const broken = structuredClone(valid);
      mutate(broken);
      assert.throws(() => assertValidEnvelope(broken), undefined, `validator accepted ${label}`);
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test("TERMINAL_TASK_STATUSES and TASK_ACTIVITY_KINDS match the plan's frozen constants", () => {
  assert.ok(Object.isFrozen(TERMINAL_TASK_STATUSES));
  assert.deepEqual([...TERMINAL_TASK_STATUSES].sort(), ["cancelled", "completed", "failed", "stopped"]);

  assert.ok(Object.isFrozen(TASK_ACTIVITY_KINDS));
  assert.deepEqual(
    [...TASK_ACTIVITY_KINDS].sort(),
    ["task.completed", "task.progress", "task.started", "task.updated"],
  );

  for (const status of TERMINAL_TASK_STATUSES) {
    assert.equal(isTerminalTaskStatus(status), true, `expected "${status}" to be terminal`);
  }
  assert.equal(isTerminalTaskStatus("gremlin"), false);
  assert.equal(isTerminalTaskStatus(" Completed "), true);
  assert.equal(isTerminalTaskStatus(null), false);
});

test("multiple task.* activities sharing a taskId fold into exactly one participant", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(FLAT_THREAD_ID);

    assert.equal(view.participants.length, 3);
    assert.deepEqual(
      view.participants.map((participant) => participant.taskId).sort(),
      ["task-alpha", "task-beta", "task-gamma"],
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("last non-null wins without erasing fields a later activity omits", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(FLAT_THREAD_ID);
    const alpha = byTaskId(view, "task-alpha");

    assert.equal(alpha.role, "general-purpose");
    assert.equal(alpha.model, "model-a");
    assert.equal(alpha.title, "Alpha task");
    assert.equal(alpha.agentKind, "agent");
    assert.equal(alpha.taskType, "local_agent");
    assert.equal(alpha.effort, "high");
    assert.equal(alpha.toolUseId, "tool-use-alpha");
    assert.equal(alpha.lastToolName, "Read");
    assert.equal(alpha.status, "completed");
    assert.equal(alpha.summary, "Alpha done");
  } finally {
    cleanupFixture(fixture);
  }
});

test("firstSeenAt, lastSeenAt, activityCount, turnId, and turnIds are computed for task-alpha", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(FLAT_THREAD_ID);
    const alpha = byTaskId(view, "task-alpha");

    assert.equal(alpha.firstSeenAt, "2026-03-01T00:00:20.000Z");
    assert.equal(alpha.lastSeenAt, "2026-03-01T00:00:40.000Z");
    assert.equal(alpha.activityCount, 3);
    assert.equal(alpha.turnId, "pturn-1");
    assert.deepEqual(alpha.turnIds, ["pturn-1"]);
  } finally {
    cleanupFixture(fixture);
  }
});

// Discriminates the documented decision (src/participants.js:183): turnId keeps the first
// non-null turn_id, not the literal turn of the earliest contributing activity (which would be
// null here) and not the last non-null turn_id (which a last-non-null-wins fold would report).
test("turnId keeps the first non-null turn_id across activities, not null and not the last", async () => {
  const fixture = createFoldAcrossActivitiesFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(FOLD_THREAD_ID);
    const task = byTaskId(view, "fold-turn-null-then-two-real");

    // Activity order: turn_id null, then FOLD_TURN_A, then FOLD_TURN_B.
    assert.equal(task.turnId, FOLD_TURN_A);
    assert.notEqual(task.turnId, FOLD_TURN_B);
    assert.deepEqual(task.turnIds, [FOLD_TURN_A, FOLD_TURN_B]);
    assertValidEnvelope(view);
  } finally {
    cleanupFixture(fixture);
  }
});

test("state mapping: terminal status finishes, missing status is unknown, unrecognised status keeps running", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(FLAT_THREAD_ID);

    const alpha = byTaskId(view, "task-alpha");
    assert.equal(alpha.status, "completed");
    assert.equal(alpha.state, "finished");

    const beta = byTaskId(view, "task-beta");
    assert.equal(beta.status, null);
    assert.equal(beta.state, "unknown");

    const gamma = byTaskId(view, "task-gamma");
    assert.equal(gamma.status, "gremlin");
    assert.equal(gamma.state, "running");
  } finally {
    cleanupFixture(fixture);
  }
});

test("usage prefers typedUsage over snake_case usage, and unknown values are null rather than zero", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(FLAT_THREAD_ID);

    const alpha = byTaskId(view, "task-alpha");
    assert.deepEqual(alpha.usage, { totalTokens: 1500, toolUses: 5, durationMs: 6000 });

    const beta = byTaskId(view, "task-beta");
    assert.deepEqual(beta.usage, { totalTokens: null, toolUses: null, durationMs: null });
  } finally {
    cleanupFixture(fixture);
  }
});

test("unmodelled projected keys land in adapterSpecific and never at the top level", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(FLAT_THREAD_ID);
    const alpha = byTaskId(view, "task-alpha");

    assert.equal(alpha.adapterSpecific.phaseIndex, 2);
    assert.deepEqual(alpha.adapterSpecific.runHandles, { runId: "run-1" });
    assert.equal(Object.hasOwn(alpha, "phaseIndex"), false);
    assert.equal(Object.hasOwn(alpha, "runHandles"), false);
  } finally {
    cleanupFixture(fixture);
  }
});

test("non-task activities are ignored and a tool argument taskId does not add an activity", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(FLAT_THREAD_ID);

    assert.equal(view.participants.length, 3);
    const alpha = byTaskId(view, "task-alpha");
    // pa-8 (tool.started) carries data.input.taskId "task-alpha" but must not be folded in:
    // only pa-1, pa-3, pa-4 (the three task.* rows) contribute.
    assert.equal(alpha.activityCount, 3);
  } finally {
    cleanupFixture(fixture);
  }
});

test("a thread with no task activities returns a valid empty envelope, not an error", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(EMPTY_THREAD_ID);

    assert.deepEqual(view.participants, []);
    assert.equal(view.counts.total, 0);
    assert.equal(view.hierarchyAvailable, false);
    assertValidEnvelope(view);
  } finally {
    cleanupFixture(fixture);
  }
});

test("a soft-deleted thread and a nonexistent thread both raise ThreadNotFoundError with exitCode 2", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });

    await assert.rejects(
      () => client.listParticipants(DELETED_THREAD_ID),
      (error) => {
        assert.ok(error instanceof ThreadNotFoundError);
        assert.equal(error.exitCode, EXIT_CODES.THREAD_NOT_FOUND);
        return true;
      },
    );

    await assert.rejects(
      () => client.listParticipants("participant-nonexistent-thread"),
      (error) => {
        assert.ok(error instanceof ThreadNotFoundError);
        assert.equal(error.exitCode, EXIT_CODES.THREAD_NOT_FOUND);
        return true;
      },
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("a malformed payload warns without throwing or dropping the thread's other participants, and a taskId-less payload is skipped", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(BROKEN_THREAD_ID);

    assert.deepEqual(
      view.participants.map((participant) => participant.taskId).sort(),
      ["cycle-a", "cycle-b", "orphan-task", "tie-a-task", "tie-b-task"],
    );

    const malformedWarning = view.warnings.find((warning) => warning.code === "MALFORMED_JSON");
    assert.ok(malformedWarning, "expected a MALFORMED_JSON warning");
  } finally {
    cleanupFixture(fixture);
  }
});

test("ordering is oldest-first by firstSeenAt with a taskId tie-breaker, and --reverse flips it", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const ascending = await client.listParticipants(BROKEN_THREAD_ID);

    assert.deepEqual(
      ascending.participants.map((participant) => participant.taskId),
      ["orphan-task", "cycle-a", "cycle-b", "tie-a-task", "tie-b-task"],
    );

    const descending = await client.listParticipants(BROKEN_THREAD_ID, { reverse: true });
    assert.deepEqual(
      descending.participants.map((participant) => participant.taskId),
      ["tie-b-task", "tie-a-task", "cycle-b", "cycle-a", "orphan-task"],
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("a null firstSeenAt sorts last in both ascending and reversed order", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const ascending = await client.listParticipants(TREE_THREAD_ID);
    const descending = await client.listParticipants(TREE_THREAD_ID, { reverse: true });

    assert.equal(ascending.participants.at(-1).taskId, "null-time-task");
    // Per the Increment 1 null-timestamp rule (reused here, not reimplemented), a null
    // firstSeenAt sorts last in BOTH directions -- it must not become first on reverse.
    assert.equal(descending.participants.at(-1).taskId, "null-time-task");
  } finally {
    cleanupFixture(fixture);
  }
});

test("limit and offset page the result while counts.total reports the full match count", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const page = await client.listParticipants(BROKEN_THREAD_ID, { limit: 2, offset: 1 });

    assert.equal(page.counts.total, 5);
    assert.equal(page.participants.length, 2);
    assert.deepEqual(
      page.participants.map((participant) => participant.taskId),
      ["cycle-a", "cycle-b"],
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("a resolvable parentAgentId produces parentTaskId, depth, and path three levels deep", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(TREE_THREAD_ID);

    const root = byTaskId(view, "root-task");
    assert.equal(root.parentTaskId, null);
    assert.equal(root.depth, 0);
    assert.equal(root.path, "main.subagent1");

    const child = byTaskId(view, "child-task");
    assert.equal(child.parentTaskId, "root-task");
    assert.equal(child.depth, 1);
    assert.equal(child.path, "main.subagent1.subagent1a");

    const grandchild = byTaskId(view, "grandchild-task");
    assert.equal(grandchild.parentTaskId, "child-task");
    assert.equal(grandchild.depth, 2);
    assert.equal(grandchild.path, "main.subagent1.subagent1a.subagent1a1");

    const secondChild = byTaskId(view, "second-child-task");
    assert.equal(secondChild.parentTaskId, "root-task");
    assert.equal(secondChild.depth, 1);
    assert.equal(secondChild.path, "main.subagent1.subagent1b");
  } finally {
    cleanupFixture(fixture);
  }
});

test("hierarchyAvailable is true only when at least one edge resolves", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });

    const tree = await client.listParticipants(TREE_THREAD_ID);
    assert.equal(tree.hierarchyAvailable, true);

    const flat = await client.listParticipants(FLAT_THREAD_ID);
    assert.equal(flat.hierarchyAvailable, false);
  } finally {
    cleanupFixture(fixture);
  }
});

test("an unresolved parentAgentId leaves parentTaskId and path null and emits UNRESOLVED_PARENT", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(BROKEN_THREAD_ID);
    const orphan = byTaskId(view, "orphan-task");

    assert.equal(orphan.parentTaskId, null);
    assert.equal(orphan.path, null);

    const warning = view.warnings.find((entry) => entry.code === "UNRESOLVED_PARENT");
    assert.ok(warning, "expected an UNRESOLVED_PARENT warning");
    assert.equal(warning.details.taskId, "orphan-task");
    assert.equal(warning.details.parentAgentId, "missing-parent-task");
    assert.equal(view.counts.unresolvedParents, 1);
  } finally {
    cleanupFixture(fixture);
  }
});

test("a parent cycle terminates, reports both members as roots, and emits one PARENT_CYCLE warning", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(BROKEN_THREAD_ID);

    const cycleA = byTaskId(view, "cycle-a");
    const cycleB = byTaskId(view, "cycle-b");
    assert.equal(cycleA.parentTaskId, null);
    assert.equal(cycleB.parentTaskId, null);
    assert.equal(cycleA.path, null);
    assert.equal(cycleB.path, null);

    const cycleWarnings = view.warnings.filter((entry) => entry.code === "PARENT_CYCLE");
    assert.equal(cycleWarnings.length, 1);
    assert.deepEqual(cycleWarnings[0].details.taskIds.slice().sort(), ["cycle-a", "cycle-b"]);
  } finally {
    cleanupFixture(fixture);
  }
});

test("parentage is never inferred from adjacency: two roots with no parentAgentId stay roots", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(FLAT_THREAD_ID);

    // task-alpha and task-beta are adjacent in created_at and sequence, share turn pturn-1,
    // and task-alpha's taskId even appears inside a tool call's input -- none of that may
    // ever be read as a parent/child edge. Only an explicit parentAgentId may.
    const alpha = byTaskId(view, "task-alpha");
    const beta = byTaskId(view, "task-beta");

    assert.equal(alpha.parentTaskId, null);
    assert.equal(beta.parentTaskId, null);
    assert.equal(alpha.depth, 0);
    assert.equal(beta.depth, 0);
    assert.equal(view.counts.roots, 3);
    assert.equal(view.counts.withExplicitParent, 0);
    assert.equal(view.hierarchyAvailable, false);
  } finally {
    cleanupFixture(fixture);
  }
});

test("sibling numbering is deterministic across repeated calls", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const first = await client.listParticipants(TREE_THREAD_ID);
    const second = await client.listParticipants(TREE_THREAD_ID);

    const pathsOf = (view) => Object.fromEntries(
      view.participants.map((participant) => [participant.taskId, participant.path]),
    );
    assert.deepEqual(pathsOf(first), pathsOf(second));
  } finally {
    cleanupFixture(fixture);
  }
});

test("--tree nests resolved children while keeping every participant field", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(TREE_THREAD_ID, { tree: true });

    assert.equal(view.participants.length, 2);
    const root = view.participants.find((participant) => participant.taskId === "root-task");
    const nullTime = view.participants.find((participant) => participant.taskId === "null-time-task");
    assert.ok(root);
    assert.ok(nullTime);

    assert.equal(root.children.length, 2);
    const child = root.children.find((participant) => participant.taskId === "child-task");
    assert.ok(child);
    assert.equal(child.children.length, 1);
    assert.equal(child.children[0].taskId, "grandchild-task");

    // Nested nodes still carry the full participant field set, not a stripped-down shape.
    for (const key of ["title", "role", "state", "usage", "turnIds", "path", "depth"]) {
      assert.ok(Object.hasOwn(child, key), `nested child missing "${key}"`);
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test("--tree on a thread with no explicit parentage returns every participant as a root with empty children", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(FLAT_THREAD_ID, { tree: true });

    assert.equal(view.participants.length, 3);
    for (const participant of view.participants) {
      assert.deepEqual(participant.children, []);
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test("a flat listParticipants envelope validates against schemas/participants.v1.json", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(TREE_THREAD_ID);
    assertValidEnvelope(view);
  } finally {
    cleanupFixture(fixture);
  }
});

test("a --tree listParticipants envelope validates against schemas/participants.v1.json", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(TREE_THREAD_ID, { tree: true });
    assertValidEnvelope(view);
  } finally {
    cleanupFixture(fixture);
  }
});

test("a cycle demotes only its own members: a downstream non-member keeps its explicit parent", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(CYCLE_SCOPE_THREAD_ID);

    const a = byTaskId(view, "A");
    const b = byTaskId(view, "B");
    const c = byTaskId(view, "C");
    const d = byTaskId(view, "D");

    assert.equal(a.parentTaskId, null);
    assert.equal(a.path, null);
    assert.equal(b.parentTaskId, null);
    assert.equal(b.path, null);

    // C's parentAgentId is A, but C never leads back to itself, so it is downstream of the
    // cycle without being a member of it and keeps its explicit edge.
    assert.equal(c.parentTaskId, "A");
    assert.equal(c.depth, 1);
    assert.equal(c.path, null);

    assert.equal(d.parentTaskId, null);

    const cycleWarnings = view.warnings.filter((entry) => entry.code === "PARENT_CYCLE");
    assert.equal(cycleWarnings.length, 1);
    assert.deepEqual(cycleWarnings[0].details.taskIds, ["A", "B"]);

    assert.equal(view.counts.withExplicitParent, 1);
    assert.equal(view.hierarchyAvailable, true);
    assertValidEnvelope(view);
  } finally {
    cleanupFixture(fixture);
  }
});

test("a self-parent is a one-node PARENT_CYCLE, not an UNRESOLVED_PARENT", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(SELF_PARENT_THREAD_ID);
    const self = byTaskId(view, "self-parent-task");

    assert.equal(self.parentTaskId, null);
    assert.equal(self.path, null);

    assert.equal(view.warnings.some((entry) => entry.code === "UNRESOLVED_PARENT"), false);
    const cycleWarnings = view.warnings.filter((entry) => entry.code === "PARENT_CYCLE");
    assert.equal(cycleWarnings.length, 1);
    assert.deepEqual(cycleWarnings[0].details.taskIds, ["self-parent-task"]);
    assertValidEnvelope(view);
  } finally {
    cleanupFixture(fixture);
  }
});

test("usage is folded per field across activities, not replaced wholesale, for typedUsage and snake_case usage alike", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(USAGE_FOLD_THREAD_ID);

    const typed = byTaskId(view, "usage-fold-typed");
    assert.deepEqual(typed.usage, { totalTokens: 200, toolUses: 5, durationMs: 20 });

    const snake = byTaskId(view, "usage-fold-snake");
    assert.deepEqual(snake.usage, { totalTokens: 200, toolUses: 5, durationMs: 20 });
  } finally {
    cleanupFixture(fixture);
  }
});

test("typedUsage wins per field over usage even when usage was reported by a later activity", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(USAGE_FOLD_THREAD_ID);
    const mixed = byTaskId(view, "usage-fold-mixed");

    // usage (snake_case) reported totalTokens:50 first; typedUsage reported totalTokens:999
    // afterward. typedUsage wins regardless of which activity came later.
    assert.deepEqual(mixed.usage, { totalTokens: 999, toolUses: 1, durationMs: 10 });
  } finally {
    cleanupFixture(fixture);
  }
});

test("a wrong-typed scalar is routed to adapterSpecific instead of breaking the declared top-level type", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(TYPE_COERCION_THREAD_ID);
    const wrongTyped = byTaskId(view, "wrong-typed-task");

    assert.equal(wrongTyped.status, "0");
    assert.equal(wrongTyped.title, null);
    assert.deepEqual(wrongTyped.adapterSpecific.title, { a: 1 });
    assert.equal(wrongTyped.isBackgrounded, null);
    assert.equal(wrongTyped.adapterSpecific.isBackgrounded, "yes");
    assertValidEnvelope(view);
  } finally {
    cleanupFixture(fixture);
  }
});

test("a legitimate isBackgrounded: false is preserved as a real boolean, not swallowed as absent", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(TYPE_COERCION_THREAD_ID);
    const boolFalse = byTaskId(view, "bool-false-task");

    assert.equal(boolFalse.isBackgrounded, false);
  } finally {
    cleanupFixture(fixture);
  }
});

// The single-activity test above only specifies the type handling; these three exercise
// isBackgrounded folding ACROSS activities for one task, which the type check alone does not.
test("isBackgrounded true then a later false folds to false across activities, the later non-null value is not swallowed", async () => {
  const fixture = createFoldAcrossActivitiesFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(FOLD_THREAD_ID);
    const task = byTaskId(view, "fold-bool-true-then-false");

    assert.equal(task.isBackgrounded, false);
    assertValidEnvelope(view);
  } finally {
    cleanupFixture(fixture);
  }
});

test("isBackgrounded false survives a later activity that omits the field, rather than reverting to null", async () => {
  const fixture = createFoldAcrossActivitiesFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(FOLD_THREAD_ID);
    const task = byTaskId(view, "fold-bool-false-then-omitted");

    assert.equal(task.isBackgrounded, false);
    assertValidEnvelope(view);
  } finally {
    cleanupFixture(fixture);
  }
});

// The real behavior is stricter than "falls back to adapterSpecific": because isBackgrounded
// already resolved to a real boolean from the earlier activity, the field is recorded in
// usableScalars, so the later wrong-typed raw value is dropped entirely rather than being kept
// anywhere -- adapterSpecific only receives a field's raw value when that field never resolves
// to a usable value in ANY activity for the task (src/participants.js:245-252). A prior guess
// that the wrong-typed value would land in adapterSpecific here does not hold; this pins the
// actual behavior instead.
test("a wrong-typed isBackgrounded reported after a real boolean does not overwrite it, and is dropped rather than surfacing in adapterSpecific", async () => {
  const fixture = createFoldAcrossActivitiesFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(FOLD_THREAD_ID);
    const task = byTaskId(view, "fold-bool-true-then-wrong-typed");

    assert.equal(task.isBackgrounded, true);
    assert.equal(task.adapterSpecific, undefined);
    assertValidEnvelope(view);
  } finally {
    cleanupFixture(fixture);
  }
});

test("a numeric taskId is emitted as a string, and a numeric parentAgentId still resolves against it", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(TYPE_COERCION_THREAD_ID);

    const numericRoot = byTaskId(view, "42");
    assert.equal(numericRoot.taskId, "42");

    const numericChild = byTaskId(view, "numeric-id-child");
    assert.equal(numericChild.parentTaskId, "42");
  } finally {
    cleanupFixture(fixture);
  }
});

test("tree paging that excludes a resolved parent surfaces the child at the top level and emits PARENT_OUT_OF_PAGE", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const page = await client.listParticipants(TREE_THREAD_ID, { tree: true, limit: 1, offset: 1 });

    // Ascending order is root-task, child-task, grandchild-task, second-child-task,
    // null-time-task; offset 1 limit 1 selects only child-task, whose resolved parent
    // (root-task) falls outside the page.
    assert.equal(page.participants.length, 1);
    assert.equal(page.participants[0].taskId, "child-task");
    assert.deepEqual(page.participants[0].children, []);

    const outOfPageWarnings = page.warnings.filter((entry) => entry.code === "PARENT_OUT_OF_PAGE");
    assert.equal(outOfPageWarnings.length, 1);
    assert.deepEqual(outOfPageWarnings[0].details.taskIds, ["child-task"]);
  } finally {
    cleanupFixture(fixture);
  }
});

test("a parent whose own activities live in a different turn produces PARENT_OUT_OF_SELECTION, not UNRESOLVED_PARENT, under a turn selection", async () => {
  const fixture = createTurnScopedFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(
      TURN_SCOPED_THREAD_ID,
      { turnId: TURN_SCOPED_TURN_2, tree: true },
    );

    assert.equal(view.participants.length, 1);
    const b = view.participants[0];
    assert.equal(b.taskId, "turn-scoped-b");
    assert.equal(b.parentTaskId, "turn-scoped-a");
    assert.equal(b.path, null);
    assert.deepEqual(b.children, []);

    const outOfSelectionWarnings = view.warnings.filter((entry) => entry.code === "PARENT_OUT_OF_SELECTION");
    assert.equal(outOfSelectionWarnings.length, 1);
    assert.deepEqual(outOfSelectionWarnings[0].details.taskIds, ["turn-scoped-b"]);

    // The same missing-parent child must never be reported under both codes at once.
    assert.equal(view.warnings.some((entry) => entry.code === "UNRESOLVED_PARENT"), false);
    assert.equal(view.warnings.some((entry) => entry.code === "PARENT_OUT_OF_PAGE"), false);
    assert.equal(view.counts.unresolvedParents, 0);
    assert.equal(view.counts.withExplicitParent, 1);
    assertValidEnvelope(view);
  } finally {
    cleanupFixture(fixture);
  }
});

// The discriminating half of the case above: read without a turn selection, the same parent
// and child nest normally with a real path and no PARENT_OUT_OF_SELECTION warning. A revert
// or a vacuous fix would leave this test and the one above with the same outcome.
test("the same turn-scoped fixture read without a turn selection nests normally with a real path", async () => {
  const fixture = createTurnScopedFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(TURN_SCOPED_THREAD_ID);

    const a = byTaskId(view, "turn-scoped-a");
    const b = byTaskId(view, "turn-scoped-b");
    assert.equal(a.parentTaskId, null);
    assert.equal(a.path, "main.subagent1");
    assert.equal(b.parentTaskId, "turn-scoped-a");
    assert.equal(b.path, "main.subagent1.subagent1a");

    assert.equal(view.warnings.some((entry) => entry.code === "PARENT_OUT_OF_SELECTION"), false);
    assert.equal(view.counts.unresolvedParents, 0);
    assertValidEnvelope(view);
  } finally {
    cleanupFixture(fixture);
  }
});

test("a parent id that exists nowhere in the thread still yields UNRESOLVED_PARENT under a turn selection", async () => {
  const fixture = createTurnScopedFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(
      TURN_SCOPED_GHOST_THREAD_ID,
      { turnId: TURN_SCOPED_GHOST_TURN },
    );
    const c = byTaskId(view, "turn-scoped-c");

    assert.equal(c.parentTaskId, null);
    assert.equal(c.path, null);

    const warning = view.warnings.find((entry) => entry.code === "UNRESOLVED_PARENT");
    assert.ok(warning, "expected an UNRESOLVED_PARENT warning");
    assert.equal(warning.details.taskId, "turn-scoped-c");
    assert.equal(warning.details.parentAgentId, "turn-scoped-ghost");
    assert.equal(view.counts.unresolvedParents, 1);
    assert.equal(view.warnings.some((entry) => entry.code === "PARENT_OUT_OF_SELECTION"), false);
    assertValidEnvelope(view);
  } finally {
    cleanupFixture(fixture);
  }
});

test("an exact turnId that matches no turn emits TURN_NOT_FOUND with an empty participants list", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(FLAT_THREAD_ID, { turnId: "does-not-exist" });

    assert.equal(view.selection.kind, "turn");
    assert.deepEqual(view.participants, []);
    const warning = view.warnings.find((entry) => entry.code === "TURN_NOT_FOUND");
    assert.ok(warning, "expected a TURN_NOT_FOUND warning");
    assert.equal(warning.details.turnId, "does-not-exist");
    assertValidEnvelope(view);
  } finally {
    cleanupFixture(fixture);
  }
});

// The discriminating half of the case above: a turn-window that lands past the end is a
// valid empty page, not an error condition, so it must never emit TURN_NOT_FOUND.
test("a turn-window offset past the end of the thread is a silent empty page, not TURN_NOT_FOUND", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(FLAT_THREAD_ID, { turnLimit: 1, turnOffset: 50 });

    assert.equal(view.selection.kind, "turn-window");
    assert.deepEqual(view.participants, []);
    assert.equal(view.warnings.some((entry) => entry.code === "TURN_NOT_FOUND"), false);
    assertValidEnvelope(view);
  } finally {
    cleanupFixture(fixture);
  }
});

test("--tree without paging emits no PARENT_OUT_OF_PAGE warning", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const view = await client.listParticipants(TREE_THREAD_ID, { tree: true });

    assert.equal(view.warnings.some((entry) => entry.code === "PARENT_OUT_OF_PAGE"), false);
  } finally {
    cleanupFixture(fixture);
  }
});

// Run in a child process with a deliberately small stack. A recursive path walk overflows
// and exits non-zero at this depth; the iterative walk uses a heap-allocated queue and is
// unaffected. Running in-process instead would prove nothing: the default stack absorbs a
// 1500-deep recursion, so the same assertions pass against a recursive implementation.
const DEEP_CHAIN_LENGTH = 1500;
const DEEP_CHAIN_STACK_KB = 384;

test("path assignment on a long explicit parent chain does not recurse", () => {
  const moduleUrl = new URL("../src/participants.js", import.meta.url).href;
  const script = `
    import(${JSON.stringify(moduleUrl)}).then(({ normalizeParticipants }) => {
      const chainLength = ${DEEP_CHAIN_LENGTH};
      const activities = [];
      for (let index = 0; index <= chainLength; index += 1) {
        const payload = { taskId: "chain-" + index };
        if (index > 0) {
          payload.parentAgentId = "chain-" + (index - 1);
        }
        activities.push({
          activity_id: "deep-" + index,
          thread_id: "deep-chain-thread",
          turn_id: null,
          kind: "task.started",
          payload_json: JSON.stringify(payload),
          created_at: null,
          sequence: index,
        });
      }
      const view = normalizeParticipants(
        { activities, selection: null },
        { threadId: "deep-chain-thread", options: { reverse: false, tree: false, limit: null, offset: 0 } },
      );
      const deepest = view.participants.find((p) => p.taskId === "chain-" + chainLength);
      if (view.participants.length !== chainLength + 1 || !deepest || deepest.depth !== chainLength) {
        console.error("unexpected fold result");
        process.exit(1);
      }
      console.log("ok");
    }).catch((error) => {
      console.error(error && error.message);
      process.exit(1);
    });
  `;

  const result = spawnSync(
    process.execPath,
    [`--stack-size=${DEEP_CHAIN_STACK_KB}`, "-e", script],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, `child failed: ${result.stderr}`);
  assert.equal(result.stdout.trim(), "ok");
});

test("every fixture thread's envelope, flat and --tree, validates against schemas/participants.v1.json", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const threadIds = [
      FLAT_THREAD_ID,
      TREE_THREAD_ID,
      BROKEN_THREAD_ID,
      EMPTY_THREAD_ID,
      CYCLE_SCOPE_THREAD_ID,
      SELF_PARENT_THREAD_ID,
      USAGE_FOLD_THREAD_ID,
      TYPE_COERCION_THREAD_ID,
    ];

    for (const threadId of threadIds) {
      assertValidEnvelope(await client.listParticipants(threadId));
      assertValidEnvelope(await client.listParticipants(threadId, { tree: true }));
    }
  } finally {
    cleanupFixture(fixture);
  }
});
