import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createT3ThreadClient,
  DatabaseUnavailableError,
  EXIT_CODES,
  InvalidArgumentsError,
  listThreadRowsFromDatabase,
  readParticipantActivitiesFromDatabase,
  readThreadFromDatabase,
  readThreadWindowFromDatabase,
  SchemaUnavailableError,
  ThreadNotFoundError,
  VERSION,
} from "../src/index.js";
import {
  REQUIRED_COLUMNS,
  REQUIRED_TABLES,
  runReadTransaction,
} from "../src/sqlite-store.js";
import {
  FLAT_THREAD_ID as PARTICIPANT_FLAT_THREAD_ID,
  createParticipantFixture,
} from "./fixtures/participant-fixture.js";
import {
  ACTIVE_THREAD_ID,
  DELETED_PROJECT_TWO_THREAD_ID,
  DELETED_THREAD_ID,
  NULL_FIELD_PROJECT_THREAD_ID,
  NULL_UPDATED_THREAD_ID,
  ORPHAN_THREAD_ID,
  PROJECT_TWO_TITLE,
  TIE_THREAD_A_ID,
  TIE_THREAD_B_ID,
  WINDOW_THREAD_ID,
  createFixtureDatabase,
} from "./fixtures/sqlite-fixture.js";
import { assertMatchesSchema } from "./fixtures/schema-assert.js";

// Chronological (oldest updated_at first) order of every non-deleted thread in the fixture.
// The null-updated thread sorts last in both directions per the documented ordering rule.
const CHRONOLOGICAL_THREAD_IDS = [
  ACTIVE_THREAD_ID,
  ORPHAN_THREAD_ID,
  NULL_FIELD_PROJECT_THREAD_ID,
  WINDOW_THREAD_ID,
  TIE_THREAD_A_ID,
  TIE_THREAD_B_ID,
  NULL_UPDATED_THREAD_ID,
];
const REVERSE_CHRONOLOGICAL_THREAD_IDS = [
  TIE_THREAD_B_ID,
  TIE_THREAD_A_ID,
  WINDOW_THREAD_ID,
  NULL_FIELD_PROJECT_THREAD_ID,
  ORPHAN_THREAD_ID,
  ACTIVE_THREAD_ID,
  NULL_UPDATED_THREAD_ID,
];

function cleanupFixture(fixture) {
  fs.rmSync(fixture.directory, { recursive: true, force: true });
}

const schemasRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "schemas");

function loadSchema(fileName) {
  return JSON.parse(fs.readFileSync(path.join(schemasRoot, fileName), "utf8"));
}

function assertValidEnvelope(envelope, schema) {
  assertMatchesSchema(envelope, schema, schema, "envelope");
}

test("retrieves and normalizes a complete thread from SQLite", async () => {
  const fixture = createFixtureDatabase();
  try {
    const before = fs.statSync(fixture.databasePath);
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const thread = await client.getThread(ACTIVE_THREAD_ID);

    assert.equal(thread.schemaVersion, "t3-thread.thread.v1");
    assert.equal(thread.toolVersion, VERSION);
    assert.deepEqual(thread.thread.project, {
      title: "Sanitized project",
      workspaceRoot: "/tmp/sanitized-workspace",
    });
    assert.equal(thread.thread.modelSelection.provider, "sanitized-model");
    assert.deepEqual(thread.turns.map((turn) => turn.turnId), ["turn-2", "turn-1"]);
    assert.deepEqual(thread.messages.map((message) => message.messageId), ["message-1", "message-2"]);
    assert.deepEqual(thread.activities.map((activity) => activity.activityId), ["activity-1", "activity-2"]);
    assert.equal(thread.provider.providerName, "SanitizedProvider");
    assert.equal(thread.provider.providerInstanceId, "instance-1");
    assert.equal(thread.warnings.length, 2);
    assert.equal(thread.messages[0].attachments[0].name, "safe.txt");
    assert.equal(thread.messages[1].attachments, null);
    assert.equal(thread.activities[1].payload.tool, "safe");
    assert.equal(thread.activities[0].payload, null);

    const after = fs.statSync(fixture.databasePath);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally {
    cleanupFixture(fixture);
  }
});

test("preserves null project and provider metadata", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const thread = await client.getThread(ORPHAN_THREAD_ID);

    assert.equal(thread.thread.projectId, "missing-project");
    assert.equal(thread.thread.project, null);
    assert.equal(thread.thread.workspaceRoot, null);
    assert.deepEqual(thread.provider, {
      providerName: null,
      providerSessionId: null,
      providerThreadId: null,
      providerInstanceId: null,
      status: null,
      lastError: null,
      activeTurnId: null,
      runtimeMode: null,
      updatedAt: null,
    });
    assert.deepEqual(thread.turns, []);
    assert.deepEqual(thread.messages, []);
    assert.deepEqual(thread.activities, []);
    assert.deepEqual(thread.warnings, []);
  } finally {
    cleanupFixture(fixture);
  }
});

test("uses the project join marker when project fields are null", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const thread = await client.getThread(NULL_FIELD_PROJECT_THREAD_ID);

    assert.deepEqual(thread.thread.project, {
      title: null,
      workspaceRoot: null,
    });
  } finally {
    cleanupFixture(fixture);
  }
});

test("treats deleted and missing threads as not found", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    await assert.rejects(
      client.getThread(DELETED_THREAD_ID),
      (error) => error instanceof ThreadNotFoundError && error.code === "THREAD_NOT_FOUND",
    );
    await assert.rejects(
      client.getThread("missing-thread-0001"),
      (error) => error instanceof ThreadNotFoundError && error.details.threadId === "missing-thread-0001",
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("distinguishes an unavailable schema from a missing thread", async () => {
  const fixture = createFixtureDatabase();
  const database = new DatabaseSync(fixture.databasePath);
  database.exec("DROP TABLE projection_turns");
  database.exec("ALTER TABLE projection_projects DROP COLUMN workspace_root");
  database.close();

  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    await assert.rejects(
      client.getThread(ACTIVE_THREAD_ID),
      (error) => error instanceof SchemaUnavailableError
        && error.code === "SCHEMA_UNAVAILABLE"
        && error.details.missingTables.includes("projection_turns")
        && error.details.missingColumns.projection_projects.includes("workspace_root"),
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("reports an unavailable database separately", async () => {
  const client = await createT3ThreadClient({ db: "/tmp/t3-thread-does-not-exist/state.sqlite" });
  await assert.rejects(
    client.getThread(ACTIVE_THREAD_ID),
    (error) => error instanceof DatabaseUnavailableError && error.code === "DATABASE_UNAVAILABLE",
  );
});

test("finds active titles with normalized results and literal wildcard matching", async () => {
  const fixture = createFixtureDatabase();
  try {
    const database = new DatabaseSync(fixture.databasePath);
    const insert = database.prepare(`
      INSERT INTO projection_threads (
        thread_id, project_id, title, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      "percent-thread-0001",
      "project-1",
      "100% coverage",
      "2026-01-04T00:00:00.000Z",
      "2026-01-04T00:04:00.000Z",
      null,
    );
    insert.run(
      "underscore-thread-0001",
      "project-1",
      "under_score",
      "2026-01-04T00:00:00.000Z",
      "2026-01-04T00:03:00.000Z",
      null,
    );
    insert.run(
      "quote-thread-0001",
      "project-1",
      "O'Reilly records",
      "2026-01-04T00:00:00.000Z",
      "2026-01-04T00:02:00.000Z",
      null,
    );
    insert.run(
      "sql-shaped-thread-0001",
      "project-1",
      "x' OR 1=1 --",
      "2026-01-04T00:00:00.000Z",
      "2026-01-04T00:01:00.000Z",
      null,
    );
    insert.run(
      "deleted-percent-thread-0001",
      "project-1",
      "100% coverage deleted",
      "2026-01-04T00:00:00.000Z",
      "2026-01-04T00:05:00.000Z",
      "2026-01-04T00:06:00.000Z",
    );
    database.close();

    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const percentMatches = await client.findThreads({ title: "  100%  " });
    assert.deepEqual(percentMatches.threads.map((match) => match.id), ["percent-thread-0001"]);
    assert.deepEqual(percentMatches.threads[0].project, {
      title: "Sanitized project",
      workspaceRoot: "/tmp/sanitized-workspace",
    });
    assert.equal(percentMatches.filters.title, "100%");
    assert.equal(percentMatches.count, 1);

    const underscoreMatches = await client.findThreads({ title: "UNDER_SCORE" });
    assert.deepEqual(underscoreMatches.threads.map((match) => match.id), ["underscore-thread-0001"]);

    const quoteMatches = await client.findThreads({ title: "o'reilly" });
    assert.deepEqual(quoteMatches.threads.map((match) => match.id), ["quote-thread-0001"]);

    const sqlMatches = await client.findThreads({ title: "' OR 1=1 --" });
    assert.deepEqual(sqlMatches.threads.map((match) => match.id), ["sql-shaped-thread-0001"]);
  } finally {
    cleanupFixture(fixture);
  }
});

test("returns a read-only doctor report with schema and counts", async () => {
  const fixture = createFixtureDatabase();
  const home = path.join(fixture.directory, "home");
  fs.mkdirSync(path.join(home, "userdata", "logs", "provider"), { recursive: true });
  try {
    const client = await createT3ThreadClient({ home, db: fixture.databasePath });
    const report = await client.doctor();

    assert.equal(report.schemaVersion, "t3-thread.doctor.v1");
    assert.equal(report.resolvedHome, home);
    assert.equal(report.databasePath, fixture.databasePath);
    assert.equal(report.databaseReadable, true);
    assert.equal(report.walPresent, false);
    assert.equal(report.schemaValid, true);
    assert.deepEqual(report.counts, { threads: 9, messages: 8, activities: 6 });
    assert.equal(report.providerLogDirectoryPresent, true);
    assert.equal(report.healthy, true);
    assert.match(report.runtimeVersion, /^v\d+/);

    const alternateHome = path.join(fixture.directory, "alternate-home");
    const overridden = await client.doctor({ home: alternateHome, db: fixture.databasePath });
    assert.equal(overridden.resolvedHome, alternateHome);
  } finally {
    cleanupFixture(fixture);
  }
});

test("a healthy doctor report validates against schemas/doctor.v1.json", async () => {
  const doctorSchema = loadSchema("doctor.v1.json");
  const fixture = createFixtureDatabase();
  const home = path.join(fixture.directory, "home");
  fs.mkdirSync(path.join(home, "userdata", "logs", "provider"), { recursive: true });
  try {
    const client = await createT3ThreadClient({ home, db: fixture.databasePath });
    const report = await client.doctor();

    assert.equal(report.healthy, true);
    assertValidEnvelope(report, doctorSchema);
  } finally {
    cleanupFixture(fixture);
  }
});

test("an unhealthy doctor report for a missing database validates against schemas/doctor.v1.json", async () => {
  const doctorSchema = loadSchema("doctor.v1.json");
  const client = await createT3ThreadClient({ db: "/tmp/t3-thread-doctor-missing/state.sqlite" });
  const report = await client.doctor();

  assert.equal(report.healthy, false);
  assert.equal(report.databaseReadable, false);
  assert.equal(report.counts, null);
  assertValidEnvelope(report, doctorSchema);
});

test("validates and trims public title-search input before opening SQLite", async () => {
  const client = await createT3ThreadClient({ db: "/tmp/t3-thread-search-input.sqlite" });

  await assert.rejects(
    client.findThreads({ title: "   " }),
    (error) => error instanceof InvalidArgumentsError && error.details.field === "title",
  );
  await assert.rejects(
    client.findThreads(),
    (error) => error instanceof InvalidArgumentsError && error.details.field === "title",
  );
});

test("reports missing required columns in doctor diagnostics", async () => {
  const fixture = createFixtureDatabase();
  const database = new DatabaseSync(fixture.databasePath);
  database.exec("ALTER TABLE projection_projects DROP COLUMN workspace_root");
  database.close();

  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const report = await client.doctor();

    assert.equal(report.databaseReadable, true);
    assert.equal(report.schemaValid, false);
    assert.deepEqual(report.schema.missingColumns.projection_projects, ["workspace_root"]);
    assert.equal(report.counts, null);
    assert.equal(report.healthy, false);
  } finally {
    cleanupFixture(fixture);
  }
});

test("list returns project/title/date metadata and no message or activity text", async () => {
  const fixture = createFixtureDatabase();
  try {
    const { rows } = listThreadRowsFromDatabase(fixture.databasePath, {});
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), [
        "branch",
        "created_at",
        "latest_turn_id",
        "latest_user_message_at",
        "project_id",
        "project_join_id",
        "project_title",
        "thread_id",
        "title",
        "updated_at",
        "workspace_root",
        "worktree_path",
      ]);
      for (const forbiddenField of ["text", "summary", "payload_json", "payload", "attachments_json"]) {
        assert.equal(Object.hasOwn(row, forbiddenField), false);
      }
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test("list defaults to oldest-first ordering across all non-deleted threads", async () => {
  const fixture = createFixtureDatabase();
  try {
    const { rows } = listThreadRowsFromDatabase(fixture.databasePath, {});
    assert.deepEqual(rows.map((row) => row.thread_id), CHRONOLOGICAL_THREAD_IDS);
  } finally {
    cleanupFixture(fixture);
  }
});

test("list reverse: true returns newest-first ordering", async () => {
  const fixture = createFixtureDatabase();
  try {
    const { rows } = listThreadRowsFromDatabase(fixture.databasePath, { reverse: true });
    assert.deepEqual(rows.map((row) => row.thread_id), REVERSE_CHRONOLOGICAL_THREAD_IDS);
  } finally {
    cleanupFixture(fixture);
  }
});

test("equal updated_at values break ties by thread_id, direction-aware", async () => {
  const fixture = createFixtureDatabase();
  try {
    const forward = listThreadRowsFromDatabase(fixture.databasePath, {});
    const forwardTieIds = forward.rows
      .map((row) => row.thread_id)
      .filter((id) => id === TIE_THREAD_A_ID || id === TIE_THREAD_B_ID);
    assert.deepEqual(forwardTieIds, [TIE_THREAD_A_ID, TIE_THREAD_B_ID]);

    const reverse = listThreadRowsFromDatabase(fixture.databasePath, { reverse: true });
    const reverseTieIds = reverse.rows
      .map((row) => row.thread_id)
      .filter((id) => id === TIE_THREAD_A_ID || id === TIE_THREAD_B_ID);
    assert.deepEqual(reverseTieIds, [TIE_THREAD_B_ID, TIE_THREAD_A_ID]);
  } finally {
    cleanupFixture(fixture);
  }
});

test("a null updated_at sorts last in both forward and reverse order", async () => {
  const fixture = createFixtureDatabase();
  try {
    const forward = listThreadRowsFromDatabase(fixture.databasePath, {});
    assert.equal(forward.rows.at(-1).thread_id, NULL_UPDATED_THREAD_ID);

    const reverse = listThreadRowsFromDatabase(fixture.databasePath, { reverse: true });
    assert.equal(reverse.rows.at(-1).thread_id, NULL_UPDATED_THREAD_ID);
  } finally {
    cleanupFixture(fixture);
  }
});

test("project matching is case-insensitive and trimmed", async () => {
  const fixture = createFixtureDatabase();
  try {
    const { rows } = listThreadRowsFromDatabase(fixture.databasePath, { project: "  codelaunch  " });
    assert.deepEqual(rows.map((row) => row.thread_id).sort(), [
      NULL_UPDATED_THREAD_ID,
      TIE_THREAD_A_ID,
      TIE_THREAD_B_ID,
      WINDOW_THREAD_ID,
    ].sort());
    assert.equal(rows.every((row) => row.project_title === PROJECT_TWO_TITLE), true);
    assert.equal(rows.some((row) => row.thread_id === DELETED_PROJECT_TWO_THREAD_ID), false);
  } finally {
    cleanupFixture(fixture);
  }
});

test("since is inclusive of the boundary timestamp", async () => {
  const fixture = createFixtureDatabase();
  try {
    const { rows } = listThreadRowsFromDatabase(fixture.databasePath, {
      since: "2026-02-02T00:00:00.000Z",
    });
    assert.deepEqual(rows.map((row) => row.thread_id).sort(), [TIE_THREAD_A_ID, TIE_THREAD_B_ID].sort());
  } finally {
    cleanupFixture(fixture);
  }
});

test("before excludes the boundary timestamp", async () => {
  const fixture = createFixtureDatabase();
  try {
    const { rows } = listThreadRowsFromDatabase(fixture.databasePath, {
      before: "2026-02-02T00:00:00.000Z",
    });
    assert.deepEqual(rows.map((row) => row.thread_id).sort(), [
      ACTIVE_THREAD_ID,
      ORPHAN_THREAD_ID,
      NULL_FIELD_PROJECT_THREAD_ID,
      WINDOW_THREAD_ID,
    ].sort());
  } finally {
    cleanupFixture(fixture);
  }
});

test("adjacent before/since windows partition non-null updated_at threads without overlap", async () => {
  const fixture = createFixtureDatabase();
  try {
    const olderWindow = listThreadRowsFromDatabase(fixture.databasePath, { before: "2026-02-01" });
    const newerWindow = listThreadRowsFromDatabase(fixture.databasePath, { since: "2026-02-01" });
    const olderIds = olderWindow.rows.map((row) => row.thread_id);
    const newerIds = newerWindow.rows.map((row) => row.thread_id);

    assert.equal(olderIds.some((id) => newerIds.includes(id)), false);
    assert.deepEqual(
      [...olderIds, ...newerIds].sort(),
      [
        ACTIVE_THREAD_ID,
        ORPHAN_THREAD_ID,
        NULL_FIELD_PROJECT_THREAD_ID,
        WINDOW_THREAD_ID,
        TIE_THREAD_A_ID,
        TIE_THREAD_B_ID,
      ].sort(),
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("list excludes deleted threads", async () => {
  const fixture = createFixtureDatabase();
  try {
    const { rows } = listThreadRowsFromDatabase(fixture.databasePath, {});
    const ids = rows.map((row) => row.thread_id);
    assert.equal(ids.includes(DELETED_THREAD_ID), false);
    assert.equal(ids.includes(DELETED_PROJECT_TWO_THREAD_ID), false);
  } finally {
    cleanupFixture(fixture);
  }
});

test("limit/offset paginate and hasMore reflects remaining rows", async () => {
  const fixture = createFixtureDatabase();
  try {
    const first = listThreadRowsFromDatabase(fixture.databasePath, { limit: 3, offset: 0 });
    assert.deepEqual(first.rows.map((row) => row.thread_id), CHRONOLOGICAL_THREAD_IDS.slice(0, 3));
    assert.equal(first.hasMore, true);

    const second = listThreadRowsFromDatabase(fixture.databasePath, { limit: 3, offset: 3 });
    assert.deepEqual(second.rows.map((row) => row.thread_id), CHRONOLOGICAL_THREAD_IDS.slice(3, 6));
    assert.equal(second.hasMore, true);

    const third = listThreadRowsFromDatabase(fixture.databasePath, { limit: 3, offset: 6 });
    assert.deepEqual(third.rows.map((row) => row.thread_id), CHRONOLOGICAL_THREAD_IDS.slice(6, 9));
    assert.equal(third.hasMore, false);

    const beyond = listThreadRowsFromDatabase(fixture.databasePath, { limit: 3, offset: 20 });
    assert.deepEqual(beyond.rows, []);
    assert.equal(beyond.hasMore, false);
  } finally {
    cleanupFixture(fixture);
  }
});

test("invalid list arguments reject before the database is opened", async () => {
  const missingDatabasePath = "/tmp/t3-thread-does-not-exist/state.sqlite";

  assert.throws(
    () => listThreadRowsFromDatabase(missingDatabasePath, { since: "not-a-date" }),
    (error) => error instanceof InvalidArgumentsError && error.details.field === "since",
  );
  assert.throws(
    () => listThreadRowsFromDatabase(missingDatabasePath, { limit: -1 }),
    (error) => error instanceof InvalidArgumentsError && error.details.field === "limit",
  );
  assert.throws(
    () => listThreadRowsFromDatabase(missingDatabasePath, { offset: "not-a-number" }),
    (error) => error instanceof InvalidArgumentsError && error.details.field === "offset",
  );
  assert.throws(
    () => listThreadRowsFromDatabase(missingDatabasePath, { project: "   " }),
    (error) => error instanceof InvalidArgumentsError && error.details.field === "project",
  );
});

test("listThreads raises DatabaseUnavailableError and SchemaUnavailableError", async () => {
  const client = await createT3ThreadClient({ db: "/tmp/t3-thread-list-missing/state.sqlite" });
  await assert.rejects(
    client.listThreads(),
    (error) => error instanceof DatabaseUnavailableError && error.code === "DATABASE_UNAVAILABLE",
  );

  const fixture = createFixtureDatabase();
  const database = new DatabaseSync(fixture.databasePath);
  database.exec("DROP TABLE projection_turns");
  database.close();

  try {
    const schemaClient = await createT3ThreadClient({ db: fixture.databasePath });
    await assert.rejects(
      schemaClient.listThreads(),
      (error) => error instanceof SchemaUnavailableError && error.code === "SCHEMA_UNAVAILABLE",
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("getThread without a turn selection has no selection property", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const thread = await client.getThread(ACTIVE_THREAD_ID);
    assert.equal(Object.hasOwn(thread, "selection"), false);
    assert.deepEqual(thread.turns.map((turn) => turn.turnId), ["turn-2", "turn-1"]);
  } finally {
    cleanupFixture(fixture);
  }
});

test("{ lastTurn: true } selects only the newest turn and its associated rows", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const thread = await client.getThread(WINDOW_THREAD_ID, { lastTurn: true });

    assert.deepEqual(thread.turns.map((turn) => turn.turnId), ["wturn-3"]);
    assert.deepEqual(thread.messages.map((message) => message.messageId).sort(), ["wextra-3", "wuser-3"].sort());
    assert.deepEqual(thread.activities.map((activity) => activity.activityId), ["wactivity-3"]);
    assert.equal(
      thread.activities.some((activity) => activity.activityId === "wactivity-unassociated"),
      false,
    );
    assert.deepEqual(thread.selection, {
      kind: "turn-window",
      turnId: null,
      turnLimit: 1,
      turnOffset: 0,
      totalTurns: 3,
      selectedTurnIds: ["wturn-3"],
    });
  } finally {
    cleanupFixture(fixture);
  }
});

test("{ turnId: \"wturn-1\" } selects exactly that turn and its messages", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const thread = await client.getThread(WINDOW_THREAD_ID, { turnId: "wturn-1" });

    assert.deepEqual(thread.turns.map((turn) => turn.turnId), ["wturn-1"]);
    assert.deepEqual(thread.messages.map((message) => message.messageId).sort(), ["wassistant-1", "wuser-1"].sort());
    assert.deepEqual(thread.activities.map((activity) => activity.activityId), ["wactivity-1"]);
    assert.deepEqual(thread.selection, {
      kind: "turn",
      turnId: "wturn-1",
      turnLimit: null,
      turnOffset: null,
      totalTurns: 3,
      selectedTurnIds: ["wturn-1"],
    });
  } finally {
    cleanupFixture(fixture);
  }
});

test("{ turnLimit: 2 } selects the two newest turns but emits them chronologically", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const thread = await client.getThread(WINDOW_THREAD_ID, { turnLimit: 2 });

    assert.deepEqual(thread.turns.map((turn) => turn.turnId), ["wturn-2", "wturn-3"]);
    assert.deepEqual(thread.selection, {
      kind: "turn-window",
      turnId: null,
      turnLimit: 2,
      turnOffset: 0,
      totalTurns: 3,
      selectedTurnIds: ["wturn-2", "wturn-3"],
    });

    // wassistant-2 matches both the turn_id IN and message_id IN clauses; the store must not
    // return it twice.
    const messageIds = thread.messages.map((message) => message.messageId);
    assert.deepEqual(messageIds, [...new Set(messageIds)]);
    assert.equal(messageIds.filter((id) => id === "wassistant-2").length, 1);
  } finally {
    cleanupFixture(fixture);
  }
});

test("{ turnLimit: 1, turnOffset: 1 } selects the second-newest turn", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const thread = await client.getThread(WINDOW_THREAD_ID, { turnLimit: 1, turnOffset: 1 });

    assert.deepEqual(thread.turns.map((turn) => turn.turnId), ["wturn-2"]);
    assert.deepEqual(thread.selection, {
      kind: "turn-window",
      turnId: null,
      turnLimit: 1,
      turnOffset: 1,
      totalTurns: 3,
      selectedTurnIds: ["wturn-2"],
    });
  } finally {
    cleanupFixture(fixture);
  }
});

test("an empty but valid window returns normalized thread metadata with empty turns/messages/activities", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const emptyWindow = await client.getThread(WINDOW_THREAD_ID, { turnLimit: 1, turnOffset: 99 });

    assert.equal(emptyWindow.thread.id, WINDOW_THREAD_ID);
    assert.deepEqual(emptyWindow.turns, []);
    assert.deepEqual(emptyWindow.messages, []);
    assert.deepEqual(emptyWindow.activities, []);
    assert.equal(emptyWindow.selection.totalTurns, 3);

    const unmatchedTurn = await client.getThread(WINDOW_THREAD_ID, { turnId: "no-such-turn" });
    assert.equal(unmatchedTurn.thread.id, WINDOW_THREAD_ID);
    assert.deepEqual(unmatchedTurn.turns, []);
    assert.deepEqual(unmatchedTurn.messages, []);
    assert.deepEqual(unmatchedTurn.activities, []);
    assert.equal(unmatchedTurn.selection.totalTurns, 3);
  } finally {
    cleanupFixture(fixture);
  }
});

test("bounded retrieval still treats deleted or missing threads as not found", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    await assert.rejects(
      client.getThread(DELETED_PROJECT_TWO_THREAD_ID, { lastTurn: true }),
      (error) => error instanceof ThreadNotFoundError,
    );
    await assert.rejects(
      client.getThread("missing-thread-0001", { turnId: "any-turn" }),
      (error) => error instanceof ThreadNotFoundError,
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("production reads do not modify the database", async () => {
  const fixture = createFixtureDatabase();
  try {
    const before = fs.statSync(fixture.databasePath);

    listThreadRowsFromDatabase(fixture.databasePath, {});
    readThreadWindowFromDatabase(fixture.databasePath, WINDOW_THREAD_ID, {
      kind: "turn-window",
      turnLimit: 1,
      turnOffset: 0,
    });

    const after = fs.statSync(fixture.databasePath);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally {
    cleanupFixture(fixture);
  }
});

test("participant reads do not modify the database, unbounded or turn-bounded", () => {
  const fixture = createParticipantFixture();
  try {
    const before = fs.statSync(fixture.databasePath);

    const unbounded = readParticipantActivitiesFromDatabase(
      fixture.databasePath,
      PARTICIPANT_FLAT_THREAD_ID,
      null,
    );
    assert.ok(unbounded.activities.length > 0);

    const bounded = readParticipantActivitiesFromDatabase(
      fixture.databasePath,
      PARTICIPANT_FLAT_THREAD_ID,
      { kind: "turn-window", turnLimit: 1, turnOffset: 0 },
    );
    assert.ok(bounded.activities.length > 0);

    const after = fs.statSync(fixture.databasePath);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally {
    cleanupFixture(fixture);
  }
});

// Matches the pattern in "distinguishes an unavailable schema from a missing thread": a
// dropped required table can only surface as SCHEMA_UNAVAILABLE if the read runs
// validateRequiredTables inside its own BEGIN DEFERRED / ROLLBACK transaction rather than
// trusting a cached schema.
test("readParticipantActivitiesFromDatabase runs the read-only deferred-transaction path", () => {
  const fixture = createParticipantFixture();
  const database = new DatabaseSync(fixture.databasePath);
  database.exec("DROP TABLE projection_turns");
  database.close();

  try {
    assert.throws(
      () => readParticipantActivitiesFromDatabase(fixture.databasePath, PARTICIPANT_FLAT_THREAD_ID, null),
      (error) => error instanceof SchemaUnavailableError
        && error.code === "SCHEMA_UNAVAILABLE"
        && error.details.missingTables.includes("projection_turns"),
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("findThreads is oldest-first by default and reverse: true flips it", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const forward = await client.findThreads({ title: "sanitized" });
    assert.equal(forward.ordering.direction, "asc");
    assert.deepEqual(forward.threads.map((match) => match.id), [
      ACTIVE_THREAD_ID,
      ORPHAN_THREAD_ID,
      WINDOW_THREAD_ID,
      TIE_THREAD_A_ID,
      TIE_THREAD_B_ID,
      NULL_UPDATED_THREAD_ID,
    ]);

    const reverse = await client.findThreads({ title: "sanitized", reverse: true });
    assert.equal(reverse.ordering.direction, "desc");
    assert.deepEqual(reverse.threads.map((match) => match.id), [
      TIE_THREAD_B_ID,
      TIE_THREAD_A_ID,
      WINDOW_THREAD_ID,
      ORPHAN_THREAD_ID,
      ACTIVE_THREAD_ID,
      NULL_UPDATED_THREAD_ID,
    ]);

    // Literal wildcard handling must still hold under the new ordering.
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare(`
      INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "reverse-percent-thread-0001",
      "project-1",
      "100% coverage",
      "2026-01-05T00:00:00.000Z",
      "2026-01-05T00:00:00.000Z",
      null,
    );
    database.close();
    const percentMatches = await client.findThreads({ title: "100%", reverse: true });
    assert.deepEqual(percentMatches.threads.map((match) => match.id), ["reverse-percent-thread-0001"]);
  } finally {
    cleanupFixture(fixture);
  }
});

test("a findThreads envelope validates against schemas/find.v1.json", async () => {
  const findSchema = loadSchema("find.v1.json");
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const result = await client.findThreads({ title: "sanitized" });
    assert.ok(result.threads.length > 0);
    assertValidEnvelope(result, findSchema);

    const empty = await client.findThreads({ title: "no-such-title-anywhere" });
    assert.equal(empty.threads.length, 0);
    assertValidEnvelope(empty, findSchema);
  } finally {
    cleanupFixture(fixture);
  }
});

test("find and list share the exact same per-thread field set", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const found = await client.findThreads({ title: "sanitized" });
    const listed = await client.listThreads({});

    assert.ok(found.threads.length > 0);
    assert.ok(listed.threads.length > 0);

    const listFields = Object.keys(listed.threads[0]).sort();
    for (const thread of found.threads) {
      assert.deepEqual(Object.keys(thread).sort(), listFields);
    }

    // The same thread reached through either command must carry identical values, not just
    // the same key set.
    const activeFromFind = found.threads.find((thread) => thread.id === ACTIVE_THREAD_ID);
    const activeFromList = listed.threads.find((thread) => thread.id === ACTIVE_THREAD_ID);
    assert.deepEqual(activeFromFind, activeFromList);
  } finally {
    cleanupFixture(fixture);
  }
});

// A task.* activity with a NULL turn_id can never satisfy a turn-bounded query's
// "turn_id IN (...)" clause, because SQL NULL never matches IN. That is deliberate and
// matches how get's turn windows already behave; this pins it as an asserted property.
test("a participant whose activities all have a null turn_id is excluded from every turn-bounded window", () => {
  const fixture = createFixtureDatabase();
  const threadId = "null-turn-participant-thread-0001";
  try {
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare(`
      INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      threadId,
      "project-1",
      "Null-turn participant thread",
      "2026-04-01T00:00:00.000Z",
      "2026-04-01T00:05:00.000Z",
      null,
    );

    const turn = database.prepare(`
      INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, started_at, completed_at)
      VALUES (?, ?, 'completed', ?, ?, ?)
    `);
    turn.run(
      threadId, "nt-turn-1",
      "2026-04-01T00:00:10.000Z", "2026-04-01T00:00:11.000Z", "2026-04-01T00:00:59.000Z",
    );
    turn.run(
      threadId, "nt-turn-2",
      "2026-04-01T00:01:10.000Z", "2026-04-01T00:01:11.000Z", "2026-04-01T00:01:59.000Z",
    );

    database.prepare(`
      INSERT INTO projection_thread_activities (
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence
      ) VALUES (?, ?, NULL, 'info', 'task.started', NULL, ?, ?, ?)
    `).run(
      "ghost-1",
      threadId,
      JSON.stringify({ taskId: "ghost-task", title: "Ghost task" }),
      "2026-04-01T00:00:20.000Z",
      1,
    );

    database.close();

    const unbounded = readParticipantActivitiesFromDatabase(fixture.databasePath, threadId, null);
    assert.deepEqual(unbounded.activities.map((row) => row.activity_id), ["ghost-1"]);

    const bounded = readParticipantActivitiesFromDatabase(fixture.databasePath, threadId, {
      kind: "turn-window",
      turnLimit: 2,
      turnOffset: 0,
    });
    assert.equal(bounded.selection.totalTurns, 2);
    assert.deepEqual(bounded.selection.selectedTurnIds.slice().sort(), ["nt-turn-1", "nt-turn-2"]);
    assert.deepEqual(bounded.activities, []);
  } finally {
    cleanupFixture(fixture);
  }
});

// Coverage gap 1: no prior test provoked real SQLite lock contention against a read path;
// every existing transient-failure test injects a DatabaseUnavailableError or deletes the
// database file instead. This one holds a genuine EXCLUSIVE lock from a second writable
// connection against the fixture's default rollback-journal (non-WAL) database and lets a
// real read path run into it with the module's real (fixed) busy_timeout.
//
// Note on what this does and does not prove: BEGIN DEFERRED takes no lock in SQLite (verified
// empirically against this runtime's node:sqlite - see the investigation note below), and a
// read-only transaction's ROLLBACK only releases a lock rather than acquiring one, so neither
// statement itself ever raises SQLITE_BUSY. Under contention the busy error surfaces at the
// first actual SELECT inside the transaction (schema inspection or the row query), which
// queryAll/listTables/listColumns already wrapped as DatabaseUnavailableError before this
// change. This test therefore closes the "real contention is never exercised" coverage gap
// and pins the end-to-end exit-4 contract, but it does not by itself discriminate the
// BEGIN/ROLLBACK guard added for issue 4 - the two tests below do that with a stub database
// whose exec() fails exactly at BEGIN or exactly at ROLLBACK.
test("real SQLite lock contention on a read path raises DatabaseUnavailableError with exit code 4", () => {
  const fixture = createFixtureDatabase();
  // createFixtureDatabase never sets journal_mode=WAL, so this is the default rollback-journal
  // mode where BEGIN EXCLUSIVE takes the lock immediately.
  const writer = new DatabaseSync(fixture.databasePath);
  writer.exec("BEGIN EXCLUSIVE");
  try {
    assert.throws(
      () => readThreadFromDatabase(fixture.databasePath, ACTIVE_THREAD_ID),
      (error) => error instanceof DatabaseUnavailableError
        && error.code === "DATABASE_UNAVAILABLE"
        && error.exitCode === EXIT_CODES.DATABASE_UNAVAILABLE,
    );
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
    cleanupFixture(fixture);
  }
});

// A database stand-in whose exec()/close() behave normally except where the test overrides
// them, and whose prepare() answers the schema-inspection queries validateRequiredTables
// issues (listTables' sqlite_schema query and listColumns' PRAGMA table_info per table) so a
// stub run reaches the caller's read body exactly like a real database would.
function createSchemaValidDatabaseStub({ execImpl = () => {}, closeImpl = () => {} } = {}) {
  return {
    exec(sql) {
      execImpl(sql);
    },
    prepare(sql) {
      if (sql.includes("sqlite_schema")) {
        return { all: () => REQUIRED_TABLES.map((name) => ({ name })) };
      }
      const match = sql.match(/PRAGMA table_info\((\w+)\)/);
      if (match) {
        return { all: () => REQUIRED_COLUMNS[match[1]].map((name) => ({ name })) };
      }
      throw new Error(`createSchemaValidDatabaseStub: unexpected prepare(${sql})`);
    },
    close() {
      closeImpl();
    },
  };
}

test("runReadTransaction classifies a BEGIN failure as DatabaseUnavailableError", () => {
  const database = createSchemaValidDatabaseStub({
    execImpl(sql) {
      if (sql === "BEGIN DEFERRED") {
        throw new Error("simulated BEGIN failure");
      }
    },
  });

  assert.throws(
    () => runReadTransaction(database, "test read", () => "unused"),
    (error) => error instanceof DatabaseUnavailableError
      && error.code === "DATABASE_UNAVAILABLE"
      && error.exitCode === EXIT_CODES.DATABASE_UNAVAILABLE
      && error.details.operation === "test read",
  );
});

test("runReadTransaction classifies a ROLLBACK failure as DatabaseUnavailableError when the read succeeded", () => {
  const database = createSchemaValidDatabaseStub({
    execImpl(sql) {
      if (sql === "ROLLBACK") {
        throw new Error("simulated ROLLBACK failure");
      }
    },
  });

  assert.throws(
    () => runReadTransaction(database, "test read", () => "ok"),
    (error) => error instanceof DatabaseUnavailableError
      && error.code === "DATABASE_UNAVAILABLE"
      && error.exitCode === EXIT_CODES.DATABASE_UNAVAILABLE,
  );
});

// The plausible half of issue 4: a ROLLBACK failure must not replace an error already in
// flight from the read body. The stub's exec() only fails on ROLLBACK; the read body throws a
// real, already-classified ThreadNotFoundError first, and that error - not the rollback
// failure - must be what the caller sees.
test("a ROLLBACK failure never replaces a classified error already in flight from the read body", () => {
  const database = createSchemaValidDatabaseStub({
    execImpl(sql) {
      if (sql === "ROLLBACK") {
        throw new Error("simulated ROLLBACK failure");
      }
    },
  });

  assert.throws(
    () => runReadTransaction(database, "test read", () => {
      throw new ThreadNotFoundError("thread-in-flight-0001");
    }),
    (error) => error instanceof ThreadNotFoundError
      && error.code === "THREAD_NOT_FOUND"
      && error.exitCode === EXIT_CODES.THREAD_NOT_FOUND
      && error.details.threadId === "thread-in-flight-0001",
  );
});

test("runReadTransaction classifies a close() failure as DatabaseUnavailableError when nothing else failed", () => {
  const database = createSchemaValidDatabaseStub({
    closeImpl() {
      throw new Error("simulated close failure");
    },
  });

  assert.throws(
    () => runReadTransaction(database, "test read", () => "ok"),
    (error) => error instanceof DatabaseUnavailableError
      && error.code === "DATABASE_UNAVAILABLE"
      && error.exitCode === EXIT_CODES.DATABASE_UNAVAILABLE,
  );
});

test("a close() failure never replaces a classified error already in flight from the read body", () => {
  const database = createSchemaValidDatabaseStub({
    closeImpl() {
      throw new Error("simulated close failure");
    },
  });

  assert.throws(
    () => runReadTransaction(database, "test read", () => {
      throw new ThreadNotFoundError("thread-in-flight-0002");
    }),
    (error) => error instanceof ThreadNotFoundError
      && error.details.threadId === "thread-in-flight-0002",
  );
});
