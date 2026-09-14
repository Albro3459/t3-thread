import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { main, parseCliArgs } from "../src/cli.js";
import { normalizeTimestamp } from "../src/query-options.js";
import { deleteThread } from "./fixtures/live-fixture.js";
import {
  BROKEN_THREAD_ID as PARTICIPANT_BROKEN_THREAD_ID,
  DELETED_THREAD_ID as PARTICIPANT_DELETED_THREAD_ID,
  EMPTY_THREAD_ID as PARTICIPANT_EMPTY_THREAD_ID,
  FLAT_THREAD_ID as PARTICIPANT_FLAT_THREAD_ID,
  TREE_THREAD_ID as PARTICIPANT_TREE_THREAD_ID,
  createParticipantFixture,
} from "./fixtures/participant-fixture.js";
import {
  ACTIVE_THREAD_ID,
  NULL_FIELD_PROJECT_THREAD_ID,
  NULL_UPDATED_THREAD_ID,
  ORPHAN_THREAD_ID,
  TIE_THREAD_A_ID,
  TIE_THREAD_B_ID,
  WINDOW_THREAD_ID,
  createFixtureDatabase,
} from "./fixtures/sqlite-fixture.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(projectRoot, "scripts", "t3-thread.js");

function cleanupFixture(fixture) {
  fs.rmSync(fixture.directory, { recursive: true, force: true });
}

function runCli(fixture, args) {
  return spawnSync(process.execPath, [executable, ...args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      T3_HOME: path.join(fixture.directory, "home"),
    },
    encoding: "utf8",
  });
}

// Event-driven process spawn for interruption and streaming tests. Never rely on real
// elapsed time here: react to the child's first stdout data or to its exit event, not to
// a sleep.
function spawnCli(fixture, args) {
  const child = spawn(process.execPath, [executable, ...args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      T3_HOME: path.join(fixture.directory, "home"),
    },
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  return {
    child,
    exited,
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

function onFirstStdoutData(spawned, callback) {
  let fired = false;
  spawned.child.stdout.on("data", () => {
    if (!fired) {
      fired = true;
      callback();
    }
  });
}

function writeProviderLog(fixture, content, threadId = ACTIVE_THREAD_ID) {
  const directory = path.join(fixture.directory, "home", "userdata", "logs", "provider");
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `events.${threadId}.log`);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function parseError(result) {
  assert.equal(result.stdout, "");
  assert.notEqual(result.stderr, "");
  return JSON.parse(result.stderr);
}

// A tail can write retry diagnostics before its fatal error, so the failure is the last
// stderr line rather than the whole stream.
function parseErrorFromStderr(stderr) {
  const lines = stderr.trimEnd().split("\n").filter(Boolean);
  assert.notEqual(lines.length, 0);
  return JSON.parse(lines.at(-1));
}

test("parses get options before and after the command", () => {
  assert.deepEqual(parseCliArgs([
    "--db", "/tmp/state.sqlite",
    "get", ACTIVE_THREAD_ID,
    "--format", "jsonl",
    "--raw-jsonl",
  ]), {
    command: "get",
    args: [ACTIVE_THREAD_ID],
    home: undefined,
    db: "/tmp/state.sqlite",
    format: "jsonl",
    title: undefined,
    project: undefined,
    since: undefined,
    before: undefined,
    limit: undefined,
    offset: undefined,
    reverse: false,
    lastTurn: false,
    turn: undefined,
    turnLimit: undefined,
    turnOffset: undefined,
    tree: false,
    rawJsonl: true,
    once: false,
    interval: undefined,
    maxCycles: undefined,
    timeout: undefined,
    help: false,
    version: false,
  });
});

test("a negative numeric option value reports a negative-value error, not a missing-value error", () => {
  assert.throws(
    () => parseCliArgs(["list", "--offset", "-1"]),
    (error) => {
      assert.equal(error.code, "INVALID_ARGUMENTS");
      assert.equal(error.message, "--offset does not accept a negative value.");
      assert.deepEqual(error.details, { option: "--offset", value: "-1" });
      return true;
    },
  );

  assert.throws(
    () => parseCliArgs(["list", "--limit", "-5"]),
    (error) => {
      assert.equal(error.message, "--limit does not accept a negative value.");
      assert.deepEqual(error.details, { option: "--limit", value: "-5" });
      return true;
    },
  );
});

test("a genuinely missing option value keeps the missing-value error for an absent token, an empty token, and another flag", () => {
  assert.throws(
    () => parseCliArgs(["list", "--offset"]),
    (error) => {
      assert.equal(error.code, "INVALID_ARGUMENTS");
      assert.equal(error.message, "Missing value for --offset.");
      assert.deepEqual(error.details, { option: "--offset" });
      return true;
    },
  );

  assert.throws(
    () => parseCliArgs(["list", "--offset", "", "--limit", "1"]),
    (error) => {
      assert.equal(error.message, "Missing value for --offset.");
      return true;
    },
  );

  assert.throws(
    () => parseCliArgs(["list", "--offset", "--limit", "1"]),
    (error) => {
      assert.equal(error.message, "Missing value for --offset.");
      return true;
    },
  );
});

test("list --offset with a negative value exits 3 with a negative-value message via the CLI", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "list", "--offset", "-1", "--db", fixture.databasePath,
    ]);
    assert.equal(result.status, 3);
    const error = parseError(result);
    assert.equal(error.code, "INVALID_ARGUMENTS");
    assert.match(error.message, /does not accept a negative value/);
  } finally {
    cleanupFixture(fixture);
  }
});

test("prints human-readable thread metadata, messages, and activities", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "get",
      ACTIVE_THREAD_ID,
      "--db",
      fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Sanitized recovery thread/);
    assert.match(result.stdout, /First sanitized question/);
    assert.match(result.stdout, /Second sanitized answer/);
    assert.match(result.stdout, /First activity/);
    assert.match(result.stdout, /Activities/);
  } finally {
    cleanupFixture(fixture);
  }
});

test("emits complete thread.v1 JSON without diagnostics on stdout", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "--db",
      fixture.databasePath,
      "get",
      ACTIVE_THREAD_ID,
      "--format",
      "json",
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const thread = JSON.parse(result.stdout);
    assert.equal(thread.schemaVersion, "t3-thread.thread.v1");
    assert.equal(thread.thread.id, ACTIVE_THREAD_ID);
    assert.equal(thread.turns.length, 2);
    assert.equal(thread.messages.length, 2);
    assert.equal(thread.activities.length, 2);
    assert.equal(thread.provider.providerName, "SanitizedProvider");
    assert.equal(thread.warnings.length, 2);
  } finally {
    cleanupFixture(fixture);
  }
});

test("emits stable one-record-per-line normalized JSONL", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "get",
      ACTIVE_THREAD_ID,
      "--format",
      "jsonl",
      "--db",
      fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const records = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(records.map((record) => record.recordType), [
      "thread",
      "turn",
      "turn",
      "message",
      "activity",
      "message",
      "activity",
    ]);
    assert.ok(records.every((record) => record.schemaVersion === "t3-thread.jsonl-record.v1"));
    assert.ok(records.every((record) => record.threadId === ACTIVE_THREAD_ID));
    assert.equal(records[0].data.title, "Sanitized recovery thread");
    assert.equal(records[0].provider.providerName, "SanitizedProvider");

    // turn-1, turn-2, message-1, and activity-1 all share the 00:01:00.000Z
    // timestamp; ties break by type rank (turn, message, activity).
    const idsAfterHeader = records.slice(1).map((record) => (
      record.recordType === "turn" ? record.data.turnId
        : record.recordType === "message" ? record.data.messageId
          : record.data.activityId
    ));
    assert.deepEqual(idsAfterHeader, [
      "turn-1",
      "turn-2",
      "message-1",
      "activity-1",
      "message-2",
      "activity-2",
    ]);
  } finally {
    cleanupFixture(fixture);
  }
});

test("reports missing threads as a machine-readable error with exit code 2", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "get",
      "missing-thread-0001",
      "--db",
      fixture.databasePath,
    ]);

    assert.equal(result.status, 2);
    assert.deepEqual(parseError(result), {
      schemaVersion: "t3-thread.error.v1",
      code: "THREAD_NOT_FOUND",
      message: "No thread matched the supplied ID.",
      details: { threadId: "missing-thread-0001" },
    });
  } finally {
    cleanupFixture(fixture);
  }
});

test("reports unavailable databases and schemas with exit code 4", () => {
  const missingFixture = createFixtureDatabase();
  try {
    const missingResult = runCli(missingFixture, [
      "get",
      ACTIVE_THREAD_ID,
      "--db",
      path.join(missingFixture.directory, "missing.sqlite"),
      "--format",
      "json",
    ]);
    assert.equal(missingResult.status, 4);
    assert.equal(parseError(missingResult).code, "DATABASE_UNAVAILABLE");
  } finally {
    cleanupFixture(missingFixture);
  }

  const schemaFixture = createFixtureDatabase();
  try {
    const database = new DatabaseSync(schemaFixture.databasePath);
    database.exec("DROP TABLE projection_turns");
    database.close();

    const result = runCli(schemaFixture, [
      "get",
      ACTIVE_THREAD_ID,
      "--db",
      schemaFixture.databasePath,
      "--format",
      "json",
    ]);
    const error = parseError(result);
    assert.equal(result.status, 4);
    assert.equal(error.code, "SCHEMA_UNAVAILABLE");
    assert.ok(error.details.missingTables.includes("projection_turns"));
  } finally {
    cleanupFixture(schemaFixture);
  }
});

test("rejects invalid get arguments and emits raw provider JSONL records", () => {
  const fixture = createFixtureDatabase();
  try {
    const invalidResult = runCli(fixture, [
      "get",
      "--format",
      "xml",
      ACTIVE_THREAD_ID,
      "--db",
      fixture.databasePath,
    ]);
    assert.equal(invalidResult.status, 3);
    assert.equal(parseError(invalidResult).code, "INVALID_ARGUMENTS");

    writeProviderLog(fixture, [
      "[2026-08-10T10:00:00.000Z] CANON: {\"event\":\"first\"}",
      "[2026-08-10T10:00:01.000Z] NTIVE: {\"event\":\"second\"}",
      "",
    ].join("\n"));
    const rawResult = runCli(fixture, [
      "get",
      ACTIVE_THREAD_ID,
      "--raw-jsonl",
      "--db",
      fixture.databasePath,
    ]);
    assert.equal(rawResult.status, 0);
    assert.equal(rawResult.stderr, "");
    assert.deepEqual(rawResult.stdout.trimEnd().split("\n").map((line) => JSON.parse(line)), [
      {
        timestamp: "2026-08-10T10:00:00.000Z",
        label: "CANON",
        data: { event: "first" },
      },
      {
        timestamp: "2026-08-10T10:00:01.000Z",
        label: "NTIVE",
        data: { event: "second" },
      },
    ]);
  } finally {
    cleanupFixture(fixture);
  }
});

test("emits parsed raw records with exit code 5 when provider lines are malformed", () => {
  const fixture = createFixtureDatabase();
  try {
    writeProviderLog(fixture, [
      "[first] CANON: {\"value\":1}",
      "malformed provider line",
      "[second] NTIVE: {\"value\":2}",
    ].join("\n"));
    const result = runCli(fixture, [
      "get",
      ACTIVE_THREAD_ID,
      "--raw-jsonl",
      "--db",
      fixture.databasePath,
    ]);

    assert.equal(result.status, 5);
    const records = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(records.map((record) => record.data.value), [1, 2]);
    const diagnostic = JSON.parse(result.stderr);
    assert.equal(diagnostic.code, "RAW_JSONL_PARTIALLY_UNREADABLE");
    assert.equal(diagnostic.details.threadId, ACTIVE_THREAD_ID);
    assert.equal(diagnostic.details.warnings.length, 1);
    assert.equal(diagnostic.details.warnings[0].line, 2);

    const normalResult = runCli(fixture, [
      "get",
      ACTIVE_THREAD_ID,
      "--format",
      "json",
      "--db",
      fixture.databasePath,
    ]);
    assert.equal(normalResult.status, 0);
    assert.equal(normalResult.stderr, "");
  } finally {
    cleanupFixture(fixture);
  }
});

test("reports missing provider logs distinctly without writing diagnostics to stdout", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "get",
      ACTIVE_THREAD_ID,
      "--raw-jsonl",
      "--db",
      fixture.databasePath,
    ]);

    assert.equal(result.status, 4);
    assert.equal(result.stdout, "");
    const diagnostic = parseError(result);
    assert.equal(diagnostic.code, "PROVIDER_LOG_MISSING");
    assert.equal(diagnostic.details.reason, "missing");
  } finally {
    cleanupFixture(fixture);
  }
});

test("finds titles through the CLI with JSON output and no diagnostics", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "find",
      "--title",
      "  SANITIZED RECOVERY  ",
      "--format",
      "json",
      "--db",
      fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const found = JSON.parse(result.stdout);
    assert.equal(found.schemaVersion, "t3-thread.find.v1");
    assert.equal(found.filters.title, "SANITIZED RECOVERY");
    assert.equal(found.count, 1);
    assert.deepEqual(found.threads.map((match) => match.id), [ACTIVE_THREAD_ID]);
    assert.equal(found.threads[0].title, "Sanitized recovery thread");
    assert.equal(found.threads[0].project.title, "Sanitized project");
    assert.equal(found.threads[0].branch, "main");
    assert.equal(found.threads[0].worktreePath, "/tmp/sanitized-worktree");
  } finally {
    cleanupFixture(fixture);
  }
});

test("doctor emits machine-readable diagnostics on stdout and uses health exit codes", () => {
  const fixture = createFixtureDatabase();
  const home = path.join(fixture.directory, "home");
  fs.mkdirSync(path.join(home, "userdata", "logs", "provider"), { recursive: true });
  try {
    const healthyResult = runCli(fixture, [
      "doctor",
      "--format",
      "json",
      "--db",
      fixture.databasePath,
    ]);

    assert.equal(healthyResult.status, 0);
    assert.equal(healthyResult.stderr, "");
    const report = JSON.parse(healthyResult.stdout);
    assert.equal(report.schemaVersion, "t3-thread.doctor.v1");
    assert.equal(report.databaseReadable, true);
    assert.equal(report.schemaValid, true);
    assert.deepEqual(report.counts, { threads: 9, messages: 8, activities: 6 });
    assert.equal(report.providerLogDirectoryPresent, true);

    const missingResult = runCli(fixture, [
      "doctor",
      "--format",
      "json",
      "--db",
      path.join(fixture.directory, "missing.sqlite"),
    ]);
    assert.equal(missingResult.status, 4);
    assert.equal(missingResult.stderr, "");
    const missingReport = JSON.parse(missingResult.stdout);
    assert.equal(missingReport.databaseReadable, false);
    assert.equal(missingReport.schemaValid, false);
    assert.equal(missingReport.counts, null);
  } finally {
    cleanupFixture(fixture);
  }
});

test("doctor human output keeps diagnostics readable and off stderr", () => {
  const fixture = createFixtureDatabase();
  const home = path.join(fixture.directory, "home");
  fs.mkdirSync(path.join(home, "userdata", "logs", "provider"), { recursive: true });
  try {
    const result = runCli(fixture, ["doctor", "--db", fixture.databasePath]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /T3 Thread Doctor/);
    assert.match(result.stdout, /Database readable: yes/);
    assert.match(result.stdout, /Required columns/);
  } finally {
    cleanupFixture(fixture);
  }
});

test("doctor human output labels dropped required tables as table missing", () => {
  const fixture = createFixtureDatabase();
  try {
    const database = new DatabaseSync(fixture.databasePath);
    database.exec("DROP TABLE projection_turns");
    database.close();

    const result = runCli(fixture, ["doctor", "--db", fixture.databasePath]);

    assert.equal(result.status, 4);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /- projection_turns: missing/);
    assert.match(result.stdout, /- projection_turns: table missing/);
    assert.doesNotMatch(result.stdout, /projection_turns: present \(table missing\)/);
  } finally {
    cleanupFixture(fixture);
  }
});

test("parses list options before and after the command", () => {
  assert.deepEqual(parseCliArgs([
    "--db", "/tmp/state.sqlite",
    "--reverse",
    "list",
    "--project", "CodeLaunch",
    "--since", "2026-01-01T00:00:00Z",
    "--before", "2026-02-01T00:00:00Z",
    "--limit", "10",
    "--offset", "5",
    "--format", "json",
  ]), {
    command: "list",
    args: [],
    home: undefined,
    db: "/tmp/state.sqlite",
    format: "json",
    title: undefined,
    project: "CodeLaunch",
    since: "2026-01-01T00:00:00Z",
    before: "2026-02-01T00:00:00Z",
    limit: "10",
    offset: "5",
    reverse: true,
    lastTurn: false,
    turn: undefined,
    turnLimit: undefined,
    turnOffset: undefined,
    tree: false,
    rawJsonl: false,
    once: false,
    interval: undefined,
    maxCycles: undefined,
    timeout: undefined,
    help: false,
    version: false,
  });
});

test("tail parses its options before and after the command", () => {
  assert.deepEqual(parseCliArgs([
    "--db", "/tmp/state.sqlite",
    "--once",
    "tail", ACTIVE_THREAD_ID,
    "--interval", "500",
    "--max-cycles", "5",
    "--timeout", "30000",
    "--turn-limit", "2",
    "--format", "jsonl",
  ]), {
    command: "tail",
    args: [ACTIVE_THREAD_ID],
    home: undefined,
    db: "/tmp/state.sqlite",
    format: "jsonl",
    title: undefined,
    project: undefined,
    since: undefined,
    before: undefined,
    limit: undefined,
    offset: undefined,
    reverse: false,
    lastTurn: false,
    turn: undefined,
    turnLimit: "2",
    turnOffset: undefined,
    tree: false,
    rawJsonl: false,
    once: true,
    interval: "500",
    maxCycles: "5",
    timeout: "30000",
    help: false,
    version: false,
  });
});

test("list --format json emits a t3-thread.list.v1 envelope with metadata-only summaries", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, ["list", "--format", "json", "--db", fixture.databasePath]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const list = JSON.parse(result.stdout);
    assert.equal(list.schemaVersion, "t3-thread.list.v1");
    assert.equal(list.ordering.sortBy, "updatedAt");
    assert.equal(list.ordering.direction, "asc");
    assert.equal(list.count, 7);
    assert.equal(list.threads.length, 7);
    assert.equal(list.hasMore, false);
    for (const summary of list.threads) {
      assert.equal(Object.hasOwn(summary, "messages"), false);
      assert.equal(Object.hasOwn(summary, "activities"), false);
    }
    const serialized = JSON.stringify(list);
    assert.doesNotMatch(serialized, /First sanitized question/);
    assert.doesNotMatch(serialized, /Windowed question one/);
    assert.doesNotMatch(serialized, /First activity/);
  } finally {
    cleanupFixture(fixture);
  }
});

test("list --format jsonl emits a list header followed by one thread record per summary", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, ["list", "--format", "jsonl", "--db", fixture.databasePath]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const records = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
    assert.equal(records[0].recordType, "list");
    assert.equal(records[0].threadId, null);
    assert.equal(records[0].data.count, records.length - 1);
    assert.deepEqual(records.slice(1).map((record) => record.recordType), records.slice(1).map(() => "thread"));
  } finally {
    cleanupFixture(fixture);
  }
});

test("list human output is readable and contains the filter block", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, ["list", "--db", fixture.databasePath]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^Threads$/m);
    assert.match(result.stdout, /^Project: -$/m);
    assert.match(result.stdout, /^Since: -$/m);
    assert.match(result.stdout, /^Before: -$/m);
    assert.match(result.stdout, /^Order: updatedAt asc$/m);
    assert.match(result.stdout, /^Limit: 50$/m);
  } finally {
    cleanupFixture(fixture);
  }
});

test("list --project trims input and matches case-insensitively", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "list", "--project", "  codelaunch  ", "--format", "json", "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const list = JSON.parse(result.stdout);
    assert.deepEqual(list.threads.map((thread) => thread.id), [
      WINDOW_THREAD_ID,
      TIE_THREAD_A_ID,
      TIE_THREAD_B_ID,
      NULL_UPDATED_THREAD_ID,
    ]);
  } finally {
    cleanupFixture(fixture);
  }
});

test("list --reverse paginates with limit and offset", () => {
  const fixture = createFixtureDatabase();
  try {
    const firstPage = runCli(fixture, [
      "list", "--reverse", "--limit", "2", "--format", "json", "--db", fixture.databasePath,
    ]);
    assert.equal(firstPage.status, 0);
    assert.equal(firstPage.stderr, "");
    const firstList = JSON.parse(firstPage.stdout);
    assert.deepEqual(firstList.threads.map((thread) => thread.id), [TIE_THREAD_B_ID, TIE_THREAD_A_ID]);
    assert.equal(firstList.hasMore, true);

    const lastPage = runCli(fixture, [
      "list", "--reverse", "--limit", "2", "--offset", "6", "--format", "json", "--db", fixture.databasePath,
    ]);
    assert.equal(lastPage.status, 0);
    assert.equal(lastPage.stderr, "");
    const lastList = JSON.parse(lastPage.stdout);
    assert.deepEqual(lastList.threads.map((thread) => thread.id), [NULL_UPDATED_THREAD_ID]);
    assert.equal(lastList.hasMore, false);
  } finally {
    cleanupFixture(fixture);
  }
});

test("list filters by since (inclusive) and before (exclusive)", () => {
  const fixture = createFixtureDatabase();
  try {
    const sinceResult = runCli(fixture, [
      "list", "--since", "2026-02-01T00:00:00.000Z", "--format", "json", "--db", fixture.databasePath,
    ]);
    assert.equal(sinceResult.status, 0);
    assert.equal(sinceResult.stderr, "");
    const sinceList = JSON.parse(sinceResult.stdout);
    assert.deepEqual(sinceList.threads.map((thread) => thread.id), [
      WINDOW_THREAD_ID,
      TIE_THREAD_A_ID,
      TIE_THREAD_B_ID,
    ]);

    const beforeResult = runCli(fixture, [
      "list", "--before", "2026-02-02T00:00:00.000Z", "--format", "json", "--db", fixture.databasePath,
    ]);
    assert.equal(beforeResult.status, 0);
    assert.equal(beforeResult.stderr, "");
    const beforeList = JSON.parse(beforeResult.stdout);
    assert.deepEqual(beforeList.threads.map((thread) => thread.id), [
      ACTIVE_THREAD_ID,
      ORPHAN_THREAD_ID,
      NULL_FIELD_PROJECT_THREAD_ID,
      WINDOW_THREAD_ID,
    ]);
  } finally {
    cleanupFixture(fixture);
  }
});

test("normalizeTimestamp interprets an offset-less date-time as UTC regardless of host timezone", () => {
  const originalTz = process.env.TZ;
  // A host west of UTC would shift an offset-less date-time backwards under the old
  // local-time parsing, so this only fails without the fix.
  process.env.TZ = "America/New_York";
  try {
    assert.equal(
      normalizeTimestamp("2026-08-10T09:00:00", "since"),
      "2026-08-10T09:00:00.000Z",
    );
    assert.equal(
      normalizeTimestamp("2026-08-10T09:00:00", "since"),
      normalizeTimestamp("2026-08-10T09:00:00Z", "since"),
    );
    // The space-separated variant the regex accepts gets the same UTC treatment.
    assert.equal(
      normalizeTimestamp("2026-08-10 09:00:00", "since"),
      "2026-08-10T09:00:00.000Z",
    );
  } finally {
    if (originalTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTz;
    }
  }
});

test("normalizeTimestamp still honors explicit offsets and date-only input", () => {
  assert.equal(
    normalizeTimestamp("2026-08-10T09:00:00-05:00", "since"),
    "2026-08-10T14:00:00.000Z",
  );
  assert.equal(normalizeTimestamp("2026-08-10", "since"), "2026-08-10T00:00:00.000Z");
});

test("list --since with an offset-less date-time agrees with the Z form across host timezones", () => {
  const fixture = createFixtureDatabase();
  const originalTz = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const offsetlessResult = runCli(fixture, [
      "list", "--since", "2026-02-01T00:00:00", "--format", "json", "--db", fixture.databasePath,
    ]);
    assert.equal(offsetlessResult.status, 0);
    assert.equal(offsetlessResult.stderr, "");
    const offsetlessList = JSON.parse(offsetlessResult.stdout);
    assert.deepEqual(offsetlessList.threads.map((thread) => thread.id), [
      WINDOW_THREAD_ID,
      TIE_THREAD_A_ID,
      TIE_THREAD_B_ID,
    ]);

    const zResult = runCli(fixture, [
      "list", "--since", "2026-02-01T00:00:00Z", "--format", "json", "--db", fixture.databasePath,
    ]);
    assert.equal(zResult.status, 0);
    const zList = JSON.parse(zResult.stdout);
    assert.deepEqual(offsetlessList.threads.map((thread) => thread.id), zList.threads.map((thread) => thread.id));
  } finally {
    if (originalTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTz;
    }
    cleanupFixture(fixture);
  }
});

test("list rejects invalid values before opening SQLite", () => {
  const fixture = createFixtureDatabase();
  try {
    const badLimit = runCli(fixture, ["list", "--limit", "abc", "--db", fixture.databasePath]);
    assert.equal(badLimit.status, 3);
    assert.equal(parseError(badLimit).code, "INVALID_ARGUMENTS");

    const zeroLimit = runCli(fixture, ["list", "--limit", "0", "--db", fixture.databasePath]);
    assert.equal(zeroLimit.status, 3);
    assert.equal(parseError(zeroLimit).code, "INVALID_ARGUMENTS");
    assert.match(parseError(zeroLimit).message, /must be a positive integer/);

    const badSince = runCli(fixture, ["list", "--since", "not-a-date", "--db", fixture.databasePath]);
    assert.equal(badSince.status, 3);
    assert.equal(parseError(badSince).code, "INVALID_ARGUMENTS");

    const badProject = runCli(fixture, ["list", "--project", "   ", "--db", fixture.databasePath]);
    assert.equal(badProject.status, 3);
    assert.equal(parseError(badProject).code, "INVALID_ARGUMENTS");

    const badFormat = runCli(fixture, ["list", "--format", "xml", "--db", fixture.databasePath]);
    assert.equal(badFormat.status, 3);
    assert.equal(parseError(badFormat).code, "INVALID_ARGUMENTS");
  } finally {
    cleanupFixture(fixture);
  }
});

test("list rejects positional arguments, --title, and --raw-jsonl", () => {
  const fixture = createFixtureDatabase();
  try {
    const positional = runCli(fixture, ["list", "extra", "--db", fixture.databasePath]);
    assert.equal(positional.status, 3);
    assert.equal(parseError(positional).code, "INVALID_ARGUMENTS");

    const withTitle = runCli(fixture, ["list", "--title", "foo", "--db", fixture.databasePath]);
    assert.equal(withTitle.status, 3);
    assert.equal(parseError(withTitle).code, "INVALID_ARGUMENTS");

    const withRaw = runCli(fixture, ["list", "--raw-jsonl", "--db", fixture.databasePath]);
    assert.equal(withRaw.status, 3);
    assert.equal(parseError(withRaw).code, "INVALID_ARGUMENTS");
  } finally {
    cleanupFixture(fixture);
  }
});

test("get --last-turn returns a bounded turn-window selection", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "get", WINDOW_THREAD_ID, "--last-turn", "--format", "json", "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const thread = JSON.parse(result.stdout);
    assert.equal(thread.selection.kind, "turn-window");
    assert.deepEqual(thread.selection.selectedTurnIds, ["wturn-3"]);
    assert.equal(thread.selection.totalTurns, 3);
    assert.equal(thread.turns.length, 1);
    assert.deepEqual(thread.messages.map((message) => message.messageId), ["wuser-3", "wextra-3"]);
    assert.equal(thread.activities.length, 1);
    assert.equal(thread.activities[0].activityId, "wactivity-3");
  } finally {
    cleanupFixture(fixture);
  }
});

test("get --turn selects one exact turn", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "get", WINDOW_THREAD_ID, "--turn", "wturn-1", "--format", "json", "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const thread = JSON.parse(result.stdout);
    assert.equal(thread.selection.kind, "turn");
    assert.deepEqual(thread.selection.selectedTurnIds, ["wturn-1"]);
    assert.equal(thread.turns.length, 1);
    assert.equal(thread.turns[0].turnId, "wturn-1");
    assert.equal(thread.warnings.some((entry) => entry.code === "TURN_NOT_FOUND"), false);
  } finally {
    cleanupFixture(fixture);
  }
});

test("get --turn with a turn ID that matches nothing warns TURN_NOT_FOUND and exits 2 in every format", () => {
  const fixture = createFixtureDatabase();
  try {
    for (const format of ["human", "json", "jsonl"]) {
      const result = runCli(fixture, [
        "get", WINDOW_THREAD_ID, "--turn", "does-not-exist", "--format", format, "--db", fixture.databasePath,
      ]);

      assert.equal(result.status, 2, format);
      assert.notEqual(result.stdout, "", format);
      assert.equal(result.stderr, "", format);

      if (format === "json") {
        const thread = JSON.parse(result.stdout);
        assert.equal(thread.selection.kind, "turn");
        assert.equal(thread.turns.length, 0);
        const warning = thread.warnings.find((entry) => entry.code === "TURN_NOT_FOUND");
        assert.ok(warning, "expected a TURN_NOT_FOUND warning");
        assert.equal(warning.details.turnId, "does-not-exist");
      } else if (format === "jsonl") {
        const records = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
        const header = records[0];
        assert.equal(header.recordType, "thread");
        const warning = header.warnings.find((entry) => entry.code === "TURN_NOT_FOUND");
        assert.ok(warning, "expected a TURN_NOT_FOUND warning");
      } else {
        assert.match(result.stdout, /TURN_NOT_FOUND/);
      }
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test("get --turn-offset past the end of the thread is a valid empty page: exit 0 and no TURN_NOT_FOUND warning", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "get", WINDOW_THREAD_ID, "--turn-offset", "50", "--format", "json", "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const thread = JSON.parse(result.stdout);
    assert.equal(thread.selection.kind, "turn-window");
    assert.equal(thread.turns.length, 0);
    assert.equal(thread.warnings.some((entry) => entry.code === "TURN_NOT_FOUND"), false);
  } finally {
    cleanupFixture(fixture);
  }
});

test("get --turn-limit emits only the selected window in chronological jsonl order", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "get", WINDOW_THREAD_ID, "--turn-limit", "2", "--format", "jsonl", "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const records = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
    assert.equal(records[0].recordType, "thread");
    const ids = records.slice(1).map((record) => (
      record.recordType === "turn" ? record.data.turnId
        : record.recordType === "message" ? record.data.messageId
          : record.data.activityId
    ));
    assert.deepEqual(ids, [
      "wturn-2", "wuser-2", "wactivity-2", "wassistant-2",
      "wturn-3", "wuser-3", "wactivity-3", "wextra-3",
    ]);
  } finally {
    cleanupFixture(fixture);
  }
});

test("get --turn-limit with --turn-offset selects the correct window", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "get", WINDOW_THREAD_ID, "--turn-limit", "1", "--turn-offset", "1", "--format", "json", "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const thread = JSON.parse(result.stdout);
    assert.deepEqual(thread.selection.selectedTurnIds, ["wturn-2"]);
  } finally {
    cleanupFixture(fixture);
  }
});

test("get --turn-offset alone defaults --turn-limit to 1", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "get", WINDOW_THREAD_ID, "--turn-offset", "1", "--format", "json", "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const thread = JSON.parse(result.stdout);
    assert.equal(thread.selection.kind, "turn-window");
    assert.equal(thread.selection.turnLimit, 1);
    assert.equal(thread.selection.turnOffset, 1);
    assert.deepEqual(thread.selection.selectedTurnIds, ["wturn-2"]);
  } finally {
    cleanupFixture(fixture);
  }
});

test("get --turn-limit 0 is rejected with exit code 3", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "get", WINDOW_THREAD_ID, "--turn-limit", "0", "--db", fixture.databasePath,
    ]);
    assert.equal(result.status, 3);
    const error = parseError(result);
    assert.equal(error.code, "INVALID_ARGUMENTS");
    assert.match(error.message, /must be a positive integer/);
  } finally {
    cleanupFixture(fixture);
  }
});

test("rejects mutually exclusive turn selection combinations with exit code 3", () => {
  const fixture = createFixtureDatabase();
  try {
    const combos = [
      ["get", WINDOW_THREAD_ID, "--turn", "wturn-1", "--last-turn"],
      ["get", WINDOW_THREAD_ID, "--turn", "wturn-1", "--turn-limit", "2"],
      ["get", WINDOW_THREAD_ID, "--last-turn", "--turn-limit", "2"],
      ["get", WINDOW_THREAD_ID, "--raw-jsonl", "--last-turn"],
    ];
    for (const args of combos) {
      const result = runCli(fixture, [...args, "--db", fixture.databasePath]);
      assert.equal(result.status, 3, args.join(" "));
      assert.equal(parseError(result).code, "INVALID_ARGUMENTS", args.join(" "));
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test("rejects list-only options on get and turn options on find and list", () => {
  const fixture = createFixtureDatabase();
  try {
    for (const args of [
      ["get", ACTIVE_THREAD_ID, "--project", "x"],
      ["get", ACTIVE_THREAD_ID, "--since", "2026-01-01T00:00:00Z"],
      ["get", ACTIVE_THREAD_ID, "--before", "2026-01-01T00:00:00Z"],
      ["get", ACTIVE_THREAD_ID, "--limit", "1"],
      ["get", ACTIVE_THREAD_ID, "--offset", "1"],
      ["get", ACTIVE_THREAD_ID, "--reverse"],
      ["find", "--title", "Sanitized", "--last-turn"],
      ["find", "--title", "Sanitized", "--turn", "x"],
      ["find", "--title", "Sanitized", "--turn-limit", "2"],
      ["find", "--title", "Sanitized", "--turn-offset", "1"],
      ["list", "--last-turn"],
      ["list", "--turn", "x"],
      ["list", "--turn-limit", "2"],
      ["list", "--turn-offset", "1"],
    ]) {
      const result = runCli(fixture, [...args, "--db", fixture.databasePath]);
      assert.equal(result.status, 3, args.join(" "));
      assert.equal(parseError(result).code, "INVALID_ARGUMENTS", args.join(" "));
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test("bounded human get output marks partial history", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "get", WINDOW_THREAD_ID, "--last-turn", "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Partial history: yes/);
  } finally {
    cleanupFixture(fixture);
  }
});

test("--help documents list, get turn-window, and find ordering options", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, ["--help"]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    for (const token of [
      "list",
      "--project",
      "--since",
      "--before",
      "--limit",
      "--offset",
      "--reverse",
      "--last-turn",
      "--turn",
      "--turn-limit",
      "--turn-offset",
    ]) {
      assert.ok(result.stdout.includes(token), `expected help to document ${token}`);
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test("tail --once --format json emits a single JSON array of baseline records and one end record", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "tail", ACTIVE_THREAD_ID, "--once", "--format", "json", "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const records = JSON.parse(result.stdout);
    assert.ok(Array.isArray(records));
    assert.ok(records.every((record) => record.schemaVersion === "t3-thread.tail-record.v1"));
    assert.equal(records.filter((record) => record.recordType === "thread").length, 1);
    assert.equal(records.filter((record) => record.recordType === "turn").length, 2);
    assert.equal(records.filter((record) => record.recordType === "message").length, 2);
    assert.equal(records.filter((record) => record.recordType === "activity").length, 2);
    const endRecords = records.filter((record) => record.op === "end");
    assert.equal(endRecords.length, 1);
    assert.equal(endRecords[0].data.reason, "once");
    assert.equal(records.at(-1).op, "end");
  } finally {
    cleanupFixture(fixture);
  }
});

test("tail --once --format jsonl streams tail-record.v1 lines ending with the end record", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "tail", ACTIVE_THREAD_ID, "--once", "--format", "jsonl", "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const lines = result.stdout.trimEnd().split("\n");
    const records = lines.map((line) => JSON.parse(line));
    assert.ok(records.every((record) => record.schemaVersion === "t3-thread.tail-record.v1"));
    assert.equal(records.at(-1).op, "end");
    assert.equal(records.at(-1).data.reason, "once");
  } finally {
    cleanupFixture(fixture);
  }
});

test("tail --format json is rejected for an unbounded tail", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "tail", ACTIVE_THREAD_ID, "--format", "json", "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 3);
    assert.equal(result.stdout, "");
    assert.equal(parseError(result).code, "INVALID_ARGUMENTS");
  } finally {
    cleanupFixture(fixture);
  }
});

test("tail --format human is rejected", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "tail", ACTIVE_THREAD_ID, "--once", "--format", "human", "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 3);
    assert.equal(parseError(result).code, "INVALID_ARGUMENTS");
  } finally {
    cleanupFixture(fixture);
  }
});

test("tail rejects mutually exclusive --once combinations with exit code 3", () => {
  const fixture = createFixtureDatabase();
  try {
    for (const args of [
      ["tail", ACTIVE_THREAD_ID, "--once", "--interval", "500"],
      ["tail", ACTIVE_THREAD_ID, "--once", "--max-cycles", "2"],
      ["tail", ACTIVE_THREAD_ID, "--once", "--timeout", "1000"],
    ]) {
      const result = runCli(fixture, [...args, "--db", fixture.databasePath]);
      assert.equal(result.status, 3, args.join(" "));
      assert.equal(parseError(result).code, "INVALID_ARGUMENTS", args.join(" "));
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test("tail --interval bounds are enforced", () => {
  const fixture = createFixtureDatabase();
  try {
    const tooLow = runCli(fixture, [
      "tail", ACTIVE_THREAD_ID, "--interval", "99", "--max-cycles", "1", "--db", fixture.databasePath,
    ]);
    assert.equal(tooLow.status, 3);
    assert.equal(parseError(tooLow).code, "INVALID_ARGUMENTS");

    const tooHigh = runCli(fixture, [
      "tail", ACTIVE_THREAD_ID, "--interval", "60001", "--max-cycles", "1", "--db", fixture.databasePath,
    ]);
    assert.equal(tooHigh.status, 3);
    assert.equal(parseError(tooHigh).code, "INVALID_ARGUMENTS");

    const low = runCli(fixture, [
      "tail", ACTIVE_THREAD_ID, "--interval", "100", "--max-cycles", "1", "--format", "jsonl", "--db", fixture.databasePath,
    ]);
    assert.equal(low.status, 0, low.stderr);
    assert.equal(low.stderr, "");

    const high = runCli(fixture, [
      "tail", ACTIVE_THREAD_ID, "--interval", "60000", "--max-cycles", "1", "--format", "jsonl", "--db", fixture.databasePath,
    ]);
    assert.equal(high.status, 0, high.stderr);
    assert.equal(high.stderr, "");
  } finally {
    cleanupFixture(fixture);
  }
});

test("tail rejects non-integer or non-positive --max-cycles and --timeout", () => {
  const fixture = createFixtureDatabase();
  try {
    for (const args of [
      ["tail", ACTIVE_THREAD_ID, "--max-cycles", "0"],
      ["tail", ACTIVE_THREAD_ID, "--max-cycles", "-1"],
      ["tail", ACTIVE_THREAD_ID, "--max-cycles", "abc"],
      ["tail", ACTIVE_THREAD_ID, "--timeout", "0"],
      ["tail", ACTIVE_THREAD_ID, "--timeout", "-5"],
      ["tail", ACTIVE_THREAD_ID, "--timeout", "abc"],
    ]) {
      const result = runCli(fixture, [...args, "--db", fixture.databasePath]);
      assert.equal(result.status, 3, args.join(" "));
      assert.equal(parseError(result).code, "INVALID_ARGUMENTS", args.join(" "));
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test("tail rejects list-only options, --title, and --raw-jsonl", () => {
  const fixture = createFixtureDatabase();
  try {
    for (const args of [
      ["tail", ACTIVE_THREAD_ID, "--project", "x"],
      ["tail", ACTIVE_THREAD_ID, "--since", "2026-01-01T00:00:00Z"],
      ["tail", ACTIVE_THREAD_ID, "--before", "2026-01-01T00:00:00Z"],
      ["tail", ACTIVE_THREAD_ID, "--limit", "1"],
      ["tail", ACTIVE_THREAD_ID, "--offset", "1"],
      ["tail", ACTIVE_THREAD_ID, "--reverse"],
      ["tail", ACTIVE_THREAD_ID, "--title", "foo"],
      ["tail", ACTIVE_THREAD_ID, "--raw-jsonl"],
    ]) {
      const result = runCli(fixture, [...args, "--once", "--db", fixture.databasePath]);
      assert.equal(result.status, 3, args.join(" "));
      assert.equal(parseError(result).code, "INVALID_ARGUMENTS", args.join(" "));
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test("tail rejects --last-turn, --turn, and --turn-offset but allows --turn-limit", () => {
  const fixture = createFixtureDatabase();
  try {
    for (const args of [
      ["tail", WINDOW_THREAD_ID, "--last-turn"],
      ["tail", WINDOW_THREAD_ID, "--turn", "wturn-1"],
      ["tail", WINDOW_THREAD_ID, "--turn-offset", "1"],
    ]) {
      const result = runCli(fixture, [...args, "--once", "--db", fixture.databasePath]);
      assert.equal(result.status, 3, args.join(" "));
      assert.equal(parseError(result).code, "INVALID_ARGUMENTS", args.join(" "));
    }

    const allowed = runCli(fixture, [
      "tail", WINDOW_THREAD_ID, "--once", "--turn-limit", "1", "--format", "jsonl", "--db", fixture.databasePath,
    ]);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(allowed.stderr, "");
    const records = allowed.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
    const turnRecords = records.filter((record) => record.recordType === "turn");
    assert.equal(turnRecords.length, 1);
    assert.equal(turnRecords[0].data.turnId, "wturn-3");
  } finally {
    cleanupFixture(fixture);
  }
});

// The tail engine (src/tail.js, not owned by this file) always yields exactly one end
// record before throwing ThreadNotFoundError, whether the thread was missing from the very
// first cycle or disappeared mid-tail: there is no special case for "never existed". A CLI
// that honors the streaming contract (write each record the instant it is yielded) will
// therefore always surface that single end record on stdout before the process exits 2,
// even for a thread that was never there. This intentionally mirrors the mid-tail deletion
// test below rather than reproducing get's "nothing on stdout" behavior byte-for-byte.
// A thread missing at startup is a plain retrieval failure, so it matches get exactly:
// exit 2 with nothing on stdout. Only a thread that disappears mid-tail gets an end record.
test("tail on a missing thread at startup exits 2 with nothing on stdout, exactly like get", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "tail", "missing-thread-0001", "--once", "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    const error = parseErrorFromStderr(result.stderr);
    assert.equal(error.code, "THREAD_NOT_FOUND");

    const getResult = runCli(fixture, [
      "get", "missing-thread-0001", "--format", "jsonl", "--db", fixture.databasePath,
    ]);
    assert.equal(getResult.status, result.status);
    assert.equal(getResult.stdout, result.stdout);
  } finally {
    cleanupFixture(fixture);
  }
});

test("tail --once keeps stderr empty for machine-readable formats", () => {
  const fixture = createFixtureDatabase();
  try {
    for (const format of ["jsonl", "json"]) {
      const result = runCli(fixture, [
        "tail", ACTIVE_THREAD_ID, "--once", "--format", format, "--db", fixture.databasePath,
      ]);
      assert.equal(result.status, 0, format);
      assert.equal(result.stderr, "", format);
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test("tail never opens the provider log", () => {
  const fixture = createFixtureDatabase();
  try {
    writeProviderLog(fixture, "{ not valid json\n");
    const result = runCli(fixture, [
      "tail", ACTIVE_THREAD_ID, "--once", "--format", "jsonl", "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout.toLowerCase(), /provider.?log/);
  } finally {
    cleanupFixture(fixture);
  }
});

test("--help documents tail and every Increment 2 option", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, ["--help"]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    for (const pattern of [/tail <thread-id>/, /--once/, /--interval/, /--max-cycles/, /--timeout/]) {
      assert.match(result.stdout, pattern);
    }
    assert.match(result.stdout, /--turn-limit <n>\s+Bound each poll to the newest n turns/);
    assert.match(result.stdout, /--format jsonl\|json\s+jsonl is the default; json requires a bounded tail/);
  } finally {
    cleanupFixture(fixture);
  }
});

test("SIGINT emits exactly one end record and exits 0", async () => {
  const fixture = createFixtureDatabase();
  try {
    const spawned = spawnCli(fixture, [
      "tail", ACTIVE_THREAD_ID, "--interval", "100", "--format", "jsonl", "--db", fixture.databasePath,
    ]);

    onFirstStdoutData(spawned, () => {
      spawned.child.kill("SIGINT");
    });

    const { code } = await spawned.exited;

    assert.equal(code, 0);
    const lines = spawned.getStdout().trimEnd().split("\n").filter(Boolean);
    const records = lines.map((line) => JSON.parse(line));
    const endRecords = records.filter((record) => record.op === "end");
    assert.equal(endRecords.length, 1);
    assert.equal(endRecords[0].data.reason, "interrupt");
    assert.doesNotMatch(spawned.getStderr(), /\n\s+at /);
    assert.doesNotMatch(spawned.getStderr(), /Error:/);
  } finally {
    cleanupFixture(fixture);
  }
});

// A closed pipe is only observable by writing into it, and the baseline of an idle thread
// fits entirely in the pipe buffer, so this run stops at --max-cycles rather than at the
// moment head exits. What it proves is the important part: no unhandled EPIPE, no stack
// trace, clean exit. The in-process test below drives the EPIPE branch itself.
test("a broken pipe exits quietly without an unhandled EPIPE error", async () => {
  const fixture = createFixtureDatabase();
  try {
    const cli = spawn(process.execPath, [
      executable,
      "tail", ACTIVE_THREAD_ID, "--interval", "100", "--max-cycles", "5", "--format", "jsonl",
      "--db", fixture.databasePath,
    ], {
      cwd: projectRoot,
      env: { ...process.env, T3_HOME: path.join(fixture.directory, "home") },
    });
    cli.stdout.setEncoding("utf8");
    cli.stderr.setEncoding("utf8");

    let stderr = "";
    cli.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const head = spawn("head", ["-n", "2"]);
    head.stdout.resume();
    head.stdin.on("error", () => {});
    cli.stdout.pipe(head.stdin);
    head.on("close", () => {
      cli.stdout.destroy();
    });

    const { code } = await new Promise((resolve) => {
      cli.on("exit", (exitCode, signal) => resolve({ code: exitCode, signal }));
    });

    assert.doesNotMatch(stderr, /EPIPE/);
    assert.doesNotMatch(stderr, /\n\s+at /);
    assert.ok(code === 0 || code === null, `expected a clean exit, got code=${code}`);
  } finally {
    cleanupFixture(fixture);
  }
});

// Deterministic counterpart to the spawned pipeline above: stdout reports EPIPE partway
// through the baseline, so the tail must stop writing, abort, and resolve 0 without ever
// reaching a real poll interval.
test("an EPIPE from stdout aborts an unbounded tail and exits 0", async () => {
  const fixture = createFixtureDatabase();
  try {
    const stdout = new EventEmitter();
    stdout.destroyed = false;
    stdout.chunks = [];
    stdout.write = (chunk) => {
      if (stdout.destroyed) {
        return false;
      }
      stdout.chunks.push(chunk);
      if (stdout.chunks.length === 3) {
        stdout.destroyed = true;
        queueMicrotask(() => {
          stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
        });
      }
      return true;
    };

    let stderrOutput = "";
    const stderr = { write: (chunk) => { stderrOutput += chunk; } };

    const exitCode = await main([
      "tail", ACTIVE_THREAD_ID, "--interval", "100", "--format", "jsonl",
      "--db", fixture.databasePath,
    ], { stdout, stderr });

    assert.equal(exitCode, 0);
    assert.equal(stderrOutput, "");
    assert.equal(stdout.chunks.length, 3);
  } finally {
    cleanupFixture(fixture);
  }
});

test("three consecutive transient database failures retry with diagnostics and the fourth exits 4", async () => {
  const fixture = createFixtureDatabase();
  try {
    const spawned = spawnCli(fixture, [
      "tail", ACTIVE_THREAD_ID, "--interval", "100", "--format", "jsonl", "--db", fixture.databasePath,
    ]);

    onFirstStdoutData(spawned, () => {
      fs.rmSync(fixture.databasePath, { force: true });
      fs.rmSync(`${fixture.databasePath}-wal`, { force: true });
      fs.rmSync(`${fixture.databasePath}-shm`, { force: true });
    });

    const { code } = await spawned.exited;

    assert.equal(code, 4);
    const lines = spawned.getStderr().trimEnd().split("\n").filter(Boolean);
    const diagnostics = lines.map((line) => JSON.parse(line));
    assert.equal(diagnostics.length, 4);
    for (const diagnostic of diagnostics) {
      assert.equal(diagnostic.schemaVersion, "t3-thread.error.v1");
      assert.equal(diagnostic.code, "DATABASE_UNAVAILABLE");
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test("a thread deleted mid-tail ends with reason thread-not-found and exit code 2", async () => {
  const fixture = createFixtureDatabase();
  try {
    const spawned = spawnCli(fixture, [
      "tail", ACTIVE_THREAD_ID, "--interval", "100", "--format", "jsonl", "--db", fixture.databasePath,
    ]);

    onFirstStdoutData(spawned, () => {
      deleteThread(fixture.databasePath, ACTIVE_THREAD_ID);
    });

    const { code } = await spawned.exited;

    assert.equal(code, 2);
    const lines = spawned.getStdout().trimEnd().split("\n").filter(Boolean);
    const lastRecord = JSON.parse(lines.at(-1));
    assert.equal(lastRecord.op, "end");
    assert.equal(lastRecord.data.reason, "thread-not-found");
    assert.ok(lines.every((line) => {
      JSON.parse(line);
      return true;
    }));
    const error = parseErrorFromStderr(spawned.getStderr());
    assert.equal(error.code, "THREAD_NOT_FOUND");
  } finally {
    cleanupFixture(fixture);
  }
});

const jsonlSchemaPath = path.join(projectRoot, "schemas", "jsonl-record.v1.json");
const jsonlRecordSchema = JSON.parse(fs.readFileSync(jsonlSchemaPath, "utf8"));
const participantsSchemaPath = path.join(projectRoot, "schemas", "participants.v1.json");
const participantsSchema = JSON.parse(fs.readFileSync(participantsSchemaPath, "utf8"));

function assertValidParticipantsEnvelope(view) {
  for (const key of participantsSchema.required) {
    assert.ok(Object.hasOwn(view, key), `missing required key "${key}"`);
  }
  for (const key of Object.keys(view)) {
    assert.ok(Object.hasOwn(participantsSchema.properties, key), `unexpected key "${key}"`);
  }
  const participantSchema = participantsSchema.$defs.participant;
  const walk = (participant) => {
    for (const key of participantSchema.required) {
      assert.ok(Object.hasOwn(participant, key), `missing participant key "${key}"`);
    }
    for (const key of Object.keys(participant)) {
      assert.ok(Object.hasOwn(participantSchema.properties, key), `unexpected participant key "${key}"`);
    }
    assert.ok(participantSchema.properties.state.enum.includes(participant.state));
    for (const child of participant.children || []) {
      walk(child);
    }
  };
  view.participants.forEach(walk);
}

test("participants parses its options before and after the command", () => {
  assert.deepEqual(parseCliArgs([
    "--db", "/tmp/state.sqlite",
    "participants", PARTICIPANT_TREE_THREAD_ID,
    "--tree", "--format", "json", "--limit", "5", "--reverse",
  ]), {
    command: "participants",
    args: [PARTICIPANT_TREE_THREAD_ID],
    home: undefined,
    db: "/tmp/state.sqlite",
    format: "json",
    title: undefined,
    project: undefined,
    since: undefined,
    before: undefined,
    limit: "5",
    offset: undefined,
    reverse: true,
    lastTurn: false,
    turn: undefined,
    turnLimit: undefined,
    turnOffset: undefined,
    tree: true,
    rawJsonl: false,
    once: false,
    interval: undefined,
    maxCycles: undefined,
    timeout: undefined,
    help: false,
    version: false,
  });
});

test("participants --format json emits a valid participants.v1 envelope", () => {
  const fixture = createParticipantFixture();
  try {
    const result = runCli(fixture, [
      "participants", PARTICIPANT_FLAT_THREAD_ID, "--format", "json", "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const view = JSON.parse(result.stdout);
    assert.equal(view.schemaVersion, "t3-thread.participants.v1");
    assert.equal(view.participants.length, 3);
    assert.equal(view.hierarchyAvailable, false);
    assertValidParticipantsEnvelope(view);
  } finally {
    cleanupFixture(fixture);
  }
});

test("participants --format jsonl emits a header record and one record per participant", () => {
  const fixture = createParticipantFixture();
  try {
    const result = runCli(fixture, [
      "participants", PARTICIPANT_FLAT_THREAD_ID, "--format", "jsonl", "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const records = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
    for (const record of records) {
      for (const key of jsonlRecordSchema.required) {
        assert.ok(Object.hasOwn(record, key), `missing required key "${key}"`);
      }
      assert.ok(jsonlRecordSchema.properties.recordType.enum.includes(record.recordType));
    }
    assert.equal(records[0].recordType, "participants");
    assert.equal(records[0].data.counts.total, 3);
    assert.deepEqual(records.slice(1).map((r) => r.recordType), ["participant", "participant", "participant"]);
    assert.deepEqual(
      records.slice(1).map((r) => r.data.taskId),
      ["task-alpha", "task-beta", "task-gamma"],
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("participants human output states plainly that the list is flat", () => {
  const fixture = createParticipantFixture();
  try {
    const result = runCli(fixture, [
      "participants", PARTICIPANT_FLAT_THREAD_ID, "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /flat list/i);
    assert.match(result.stdout, /Alpha task/);
    assert.match(result.stdout, /Gamma task/);
  } finally {
    cleanupFixture(fixture);
  }
});

test("participants human output enriches a participant with kind/type/effort, summary, usage, and output", () => {
  const fixture = createParticipantFixture();
  try {
    const result = runCli(fixture, [
      "participants", PARTICIPANT_FLAT_THREAD_ID, "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    assert.match(
      result.stdout,
      new RegExp(
        [
          "- Alpha task\\n",
          "\\s+Task ID: task-alpha\\n",
          "\\s+Role: general-purpose\\n",
          "\\s+Model: model-a\\n",
          "\\s+Kind: agent, Type: local_agent, Effort: high\\n",
          "\\s+State: finished\\n",
          "\\s+Status: completed\\n",
          "\\s+Summary: Alpha done\\n",
          "\\s+Turn: pturn-1\\n",
          "\\s+Seen: 2026-03-01T00:00:20\\.000Z -> 2026-03-01T00:00:40\\.000Z\\n",
          "\\s+Activities: 3 \\(tool uses: 5, tokens: 1500, duration: 6\\.0s\\)\\n",
          "\\s+Last tool: Read\\n",
          "\\s+Output: /tmp/alpha\\.out\\n",
        ].join(""),
      ),
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("participants human output omits a field group entirely when every value in it is null", () => {
  const fixture = createParticipantFixture();
  try {
    const result = runCli(fixture, [
      "participants", PARTICIPANT_FLAT_THREAD_ID, "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    const stdout = result.stdout;
    const betaStart = stdout.indexOf("- Beta task");
    const gammaStart = stdout.indexOf("- Gamma task");
    assert.ok(betaStart >= 0 && gammaStart > betaStart);
    const betaBlock = stdout.slice(betaStart, gammaStart);
    const gammaBlock = stdout.slice(gammaStart);

    // Beta has agentKind/taskType but no effort: the group line prints, but only the present
    // sub-fields, not a null Effort.
    assert.match(betaBlock, /Kind: agent, Type: local_agent\n/);
    assert.doesNotMatch(betaBlock, /Effort/);
    // Beta never reports usage at all, so the Activities line carries no parenthetical.
    assert.match(betaBlock, /Activities: 2\n/);
    assert.doesNotMatch(betaBlock, /tool uses:/);
    assert.doesNotMatch(betaBlock, /Summary:/);

    // Gamma reports neither agentKind, taskType, nor effort: the whole group line is omitted,
    // not printed with three null placeholders.
    assert.doesNotMatch(gammaBlock, /Kind:/);
    assert.doesNotMatch(gammaBlock, /Summary:/);
    assert.doesNotMatch(gammaBlock, /Last tool:/);
    // Gamma is explicitly backgrounded but has no output file: the group line prints only the
    // present sub-field.
    assert.match(gammaBlock, /Backgrounded: yes\n/);
    assert.doesNotMatch(gammaBlock, /Output:/);
  } finally {
    cleanupFixture(fixture);
  }
});

test("participants --tree nests explicit children", () => {
  const fixture = createParticipantFixture();
  try {
    const result = runCli(fixture, [
      "participants", PARTICIPANT_TREE_THREAD_ID, "--tree", "--format", "json",
      "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    const view = JSON.parse(result.stdout);
    assert.equal(view.hierarchyAvailable, true);
    assert.equal(view.participants.length, 2);
    const root = view.participants.find((p) => p.taskId === "root-task");
    assert.equal(root.children.length, 2);
    const child = root.children.find((p) => p.taskId === "child-task");
    assert.equal(child.children.length, 1);
    assert.equal(child.children[0].taskId, "grandchild-task");
    assertValidParticipantsEnvelope(view);
  } finally {
    cleanupFixture(fixture);
  }
});

test("participants --tree is rejected with --format jsonl and accepted otherwise", () => {
  const fixture = createParticipantFixture();
  try {
    const rejected = runCli(fixture, [
      "participants", PARTICIPANT_TREE_THREAD_ID, "--tree", "--format", "jsonl",
      "--db", fixture.databasePath,
    ]);
    assert.equal(rejected.status, 3);
    assert.equal(parseError(rejected).code, "INVALID_ARGUMENTS");

    for (const format of ["human", "json"]) {
      const accepted = runCli(fixture, [
        "participants", PARTICIPANT_TREE_THREAD_ID, "--tree", "--format", format,
        "--db", fixture.databasePath,
      ]);
      assert.equal(accepted.status, 0, format);
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test("participants --turn bounds the view and reports the selection", () => {
  const fixture = createParticipantFixture();
  try {
    const result = runCli(fixture, [
      "participants", PARTICIPANT_FLAT_THREAD_ID, "--turn", "pturn-2", "--format", "json",
      "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    const view = JSON.parse(result.stdout);
    assert.deepEqual(view.participants.map((p) => p.taskId), ["task-gamma"]);
    assert.equal(view.selection.kind, "turn");
    assert.equal(view.selection.turnId, "pturn-2");
    assert.equal(view.warnings.some((entry) => entry.code === "TURN_NOT_FOUND"), false);
  } finally {
    cleanupFixture(fixture);
  }
});

test("participants --turn with a turn ID that matches nothing warns TURN_NOT_FOUND and exits 2 in every format", () => {
  const fixture = createParticipantFixture();
  try {
    for (const format of ["human", "json", "jsonl"]) {
      const result = runCli(fixture, [
        "participants", PARTICIPANT_FLAT_THREAD_ID, "--turn", "does-not-exist", "--format", format,
        "--db", fixture.databasePath,
      ]);

      assert.equal(result.status, 2, format);
      assert.notEqual(result.stdout, "", format);
      assert.equal(result.stderr, "", format);

      if (format === "json") {
        const view = JSON.parse(result.stdout);
        assert.equal(view.selection.kind, "turn");
        assert.deepEqual(view.participants, []);
        const warning = view.warnings.find((entry) => entry.code === "TURN_NOT_FOUND");
        assert.ok(warning, "expected a TURN_NOT_FOUND warning");
        assert.equal(warning.details.turnId, "does-not-exist");
      } else if (format === "jsonl") {
        const records = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
        const header = records[0];
        assert.equal(header.recordType, "participants");
        const warning = header.data.warnings.find((entry) => entry.code === "TURN_NOT_FOUND");
        assert.ok(warning, "expected a TURN_NOT_FOUND warning");
      } else {
        assert.match(result.stdout, /TURN_NOT_FOUND/);
      }
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test("participants --turn-offset past the end of the thread is a valid empty page: exit 0 and no TURN_NOT_FOUND warning", () => {
  const fixture = createParticipantFixture();
  try {
    const result = runCli(fixture, [
      "participants", PARTICIPANT_FLAT_THREAD_ID, "--turn-offset", "50", "--format", "json",
      "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const view = JSON.parse(result.stdout);
    assert.equal(view.selection.kind, "turn-window");
    assert.deepEqual(view.participants, []);
    assert.equal(view.warnings.some((entry) => entry.code === "TURN_NOT_FOUND"), false);
  } finally {
    cleanupFixture(fixture);
  }
});

test("participants --limit, --offset, and --reverse page and order the view", () => {
  const fixture = createParticipantFixture();
  try {
    const page = runCli(fixture, [
      "participants", PARTICIPANT_FLAT_THREAD_ID, "--limit", "1", "--offset", "1",
      "--format", "json", "--db", fixture.databasePath,
    ]);
    assert.equal(page.status, 0);
    const paged = JSON.parse(page.stdout);
    assert.equal(paged.counts.total, 3);
    assert.equal(paged.counts.participants, 1);
    assert.deepEqual(paged.participants.map((p) => p.taskId), ["task-beta"]);

    const reversed = runCli(fixture, [
      "participants", PARTICIPANT_FLAT_THREAD_ID, "--reverse", "--format", "json",
      "--db", fixture.databasePath,
    ]);
    assert.deepEqual(
      JSON.parse(reversed.stdout).participants.map((p) => p.taskId),
      ["task-gamma", "task-beta", "task-alpha"],
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("participants --limit 0 is rejected with exit code 3", () => {
  const fixture = createParticipantFixture();
  try {
    const result = runCli(fixture, [
      "participants", PARTICIPANT_FLAT_THREAD_ID, "--limit", "0", "--db", fixture.databasePath,
    ]);
    assert.equal(result.status, 3);
    const error = parseError(result);
    assert.equal(error.code, "INVALID_ARGUMENTS");
    assert.match(error.message, /must be a positive integer/);
  } finally {
    cleanupFixture(fixture);
  }
});

test("participants rejects list-only filters, tail options, --title, and --raw-jsonl", () => {
  const fixture = createParticipantFixture();
  try {
    const rejected = [
      ["--title", "topic"],
      ["--raw-jsonl"],
      ["--project", "Participant project"],
      ["--since", "2026-03-01"],
      ["--before", "2026-03-09"],
      ["--once"],
      ["--interval", "500"],
      ["--max-cycles", "2"],
      ["--timeout", "1000"],
    ];

    for (const args of rejected) {
      const result = runCli(fixture, [
        "participants", PARTICIPANT_FLAT_THREAD_ID, ...args, "--db", fixture.databasePath,
      ]);
      assert.equal(result.status, 3, args.join(" "));
      assert.equal(parseError(result).code, "INVALID_ARGUMENTS", args.join(" "));
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test("participants rejects an unsupported format and a wrong argument count", () => {
  const fixture = createParticipantFixture();
  try {
    const badFormat = runCli(fixture, [
      "participants", PARTICIPANT_FLAT_THREAD_ID, "--format", "xml", "--db", fixture.databasePath,
    ]);
    assert.equal(badFormat.status, 3);
    assert.equal(parseError(badFormat).code, "INVALID_ARGUMENTS");

    const noArgs = runCli(fixture, ["participants", "--db", fixture.databasePath]);
    assert.equal(noArgs.status, 3);

    const twoArgs = runCli(fixture, [
      "participants", PARTICIPANT_FLAT_THREAD_ID, PARTICIPANT_TREE_THREAD_ID,
      "--db", fixture.databasePath,
    ]);
    assert.equal(twoArgs.status, 3);
  } finally {
    cleanupFixture(fixture);
  }
});

test("participants treats missing and soft-deleted threads as not found", () => {
  const fixture = createParticipantFixture();
  try {
    for (const threadId of ["missing-participant-thread", PARTICIPANT_DELETED_THREAD_ID]) {
      const result = runCli(fixture, [
        "participants", threadId, "--format", "json", "--db", fixture.databasePath,
      ]);
      assert.equal(result.status, 2, threadId);
      assert.equal(result.stdout, "", threadId);
      assert.equal(parseError(result).code, "THREAD_NOT_FOUND", threadId);
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test("a thread with no task activities returns an empty envelope rather than an error", () => {
  const fixture = createParticipantFixture();
  try {
    const result = runCli(fixture, [
      "participants", PARTICIPANT_EMPTY_THREAD_ID, "--format", "json", "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const view = JSON.parse(result.stdout);
    assert.deepEqual(view.participants, []);
    assert.equal(view.counts.total, 0);
    assert.equal(view.hierarchyAvailable, false);
    assertValidParticipantsEnvelope(view);

    const human = runCli(fixture, [
      "participants", PARTICIPANT_EMPTY_THREAD_ID, "--db", fixture.databasePath,
    ]);
    assert.equal(human.status, 0);
    assert.match(human.stdout, /No task participants/i);
  } finally {
    cleanupFixture(fixture);
  }
});

test("participants surfaces unresolved-parent and cycle warnings without failing", () => {
  const fixture = createParticipantFixture();
  try {
    const result = runCli(fixture, [
      "participants", PARTICIPANT_BROKEN_THREAD_ID, "--format", "json", "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    const view = JSON.parse(result.stdout);
    const codes = view.warnings.map((warning) => warning.code);
    assert.ok(codes.includes("UNRESOLVED_PARENT"));
    assert.ok(codes.includes("PARENT_CYCLE"));
    assert.equal(view.hierarchyAvailable, false);
    assertValidParticipantsEnvelope(view);
  } finally {
    cleanupFixture(fixture);
  }
});

test("--help documents participants and every Increment 3 option", () => {
  const fixture = createParticipantFixture();
  try {
    const result = runCli(fixture, ["--help"]);
    assert.equal(result.status, 0);
    const participantsHelpLines = [
      "  participants <thread-id>  List the task participants in a thread",
      "    --tree                 Nest explicit parent/child relationships",
      "    --last-turn            Only participants whose activities touch the newest turn",
      "    --turn <turn-id>       Only participants whose activities touch that turn",
      "    --turn-limit <n>       Only participants touching the newest n turns (must be 1 or greater)",
      "    --turn-offset <n>      Skip turns from the newest side before --turn-limit",
      "    --limit <n>            Maximum participants returned (no default; must be 1 or greater)",
      "    --offset <n>           Skip participants before applying --limit",
      "    --reverse              Newest-first instead of the default oldest-first",
      "    --format human|json|jsonl",
    ];
    for (const line of participantsHelpLines) {
      assert.ok(result.stdout.includes(line), `missing help line: ${line}`);
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test("participants --last-turn scopes to the newest turn and reports the selection", () => {
  const fixture = createParticipantFixture();
  try {
    const result = runCli(fixture, [
      "participants", PARTICIPANT_FLAT_THREAD_ID, "--last-turn", "--format", "json",
      "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    const view = JSON.parse(result.stdout);
    assert.deepEqual(view.participants.map((p) => p.taskId), ["task-gamma"]);
    assert.equal(view.selection.kind, "turn-window");
    assert.equal(view.selection.turnLimit, 1);
    assert.equal(view.selection.turnOffset, 0);
  } finally {
    cleanupFixture(fixture);
  }
});

test("participants rejects --last-turn combined with --turn", () => {
  const fixture = createParticipantFixture();
  try {
    const result = runCli(fixture, [
      "participants", PARTICIPANT_FLAT_THREAD_ID, "--last-turn", "--turn", "pturn-2",
      "--db", fixture.databasePath,
    ]);
    assert.equal(result.status, 3);
    assert.equal(parseError(result).code, "INVALID_ARGUMENTS");
  } finally {
    cleanupFixture(fixture);
  }
});

test("participants --format json and --format jsonl produce clean stdout with empty stderr", () => {
  const fixture = createParticipantFixture();
  try {
    for (const format of ["json", "jsonl"]) {
      const result = runCli(fixture, [
        "participants", PARTICIPANT_FLAT_THREAD_ID, "--format", format, "--db", fixture.databasePath,
      ]);
      assert.equal(result.status, 0, format);
      assert.equal(result.stderr, "", format);
      if (format === "json") {
        assert.doesNotThrow(() => JSON.parse(result.stdout), format);
      } else {
        const lines = result.stdout.trimEnd().split("\n");
        assert.ok(lines.length > 0, format);
        for (const line of lines) {
          assert.doesNotThrow(() => JSON.parse(line), format);
        }
      }
    }
  } finally {
    cleanupFixture(fixture);
  }
});
