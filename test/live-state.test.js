import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createT3ThreadClient } from "../src/index.js";
import {
  ACTIVE_PROVIDER_STATUSES,
  isActiveProviderStatus,
  isTerminalTurnState,
  normalizeLiveState,
  TERMINAL_TURN_STATES,
} from "../src/normalize.js";
import {
  ACTIVE_THREAD_ID,
  createFixtureDatabase,
  ORPHAN_THREAD_ID,
  WINDOW_THREAD_ID,
} from "./fixtures/sqlite-fixture.js";
import {
  appendMessage,
  setSessionStatus,
  setThreadLatestTurn,
  setTurnState,
  updateMessage,
} from "./fixtures/live-fixture.js";

const schemaPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "schemas",
  "thread.v1.json",
);
const threadSchema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));

const FIXED_NOW = () => Date.parse("2026-08-12T10:00:00.000Z");

function cleanupFixture(fixture) {
  fs.rmSync(fixture.directory, { recursive: true, force: true });
}

test("a settled thread reports complete, idle, and no reasons", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const thread = await client.getThread(ACTIVE_THREAD_ID);

    assert.equal(thread.liveState.complete, true);
    assert.equal(thread.liveState.status, "idle");
    assert.deepEqual(thread.liveState.reasons, []);
    assert.equal(thread.liveState.providerStatus, "ready");
    assert.equal(thread.liveState.latestTurnId, "turn-2");
    assert.equal(thread.liveState.latestTurnState, "completed");
    assert.equal(thread.liveState.streamingMessageCount, 0);
  } finally {
    cleanupFixture(fixture);
  }
});

test("a non-terminal latest turn reports turn-not-terminal in isolation", async () => {
  const fixture = createFixtureDatabase();
  try {
    setSessionStatus(fixture.databasePath, WINDOW_THREAD_ID, "ready");
    updateMessage(fixture.databasePath, "wextra-3", { isStreaming: 0 });

    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const thread = await client.getThread(WINDOW_THREAD_ID);

    assert.equal(thread.liveState.complete, false);
    assert.equal(thread.liveState.status, "active");
    assert.deepEqual(thread.liveState.reasons, ["turn-not-terminal"]);
  } finally {
    cleanupFixture(fixture);
  }
});

test("a streaming message reports streaming-message in isolation", async () => {
  const fixture = createFixtureDatabase();
  try {
    appendMessage(fixture.databasePath, {
      messageId: "active-extra-streaming",
      threadId: ACTIVE_THREAD_ID,
      turnId: "turn-2",
      role: "assistant",
      text: "still typing",
      isStreaming: 1,
      createdAt: "2026-01-01T00:02:30.000Z",
      updatedAt: "2026-01-01T00:02:31.000Z",
    });

    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const thread = await client.getThread(ACTIVE_THREAD_ID);

    assert.equal(thread.liveState.complete, false);
    assert.deepEqual(thread.liveState.reasons, ["streaming-message"]);
    assert.equal(thread.liveState.streamingMessageCount, 1);
  } finally {
    cleanupFixture(fixture);
  }
});

test("an active provider session reports provider-active in isolation", async () => {
  const fixture = createFixtureDatabase();
  try {
    setSessionStatus(fixture.databasePath, ACTIVE_THREAD_ID, "running");

    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const thread = await client.getThread(ACTIVE_THREAD_ID);

    assert.equal(thread.liveState.complete, false);
    assert.deepEqual(thread.liveState.reasons, ["provider-active"]);
    assert.equal(thread.liveState.providerStatus, "running");
  } finally {
    cleanupFixture(fixture);
  }
});

test("multiple simultaneous signals produce a sorted, deduplicated reasons array", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const thread = await client.getThread(WINDOW_THREAD_ID);

    assert.deepEqual(thread.liveState.reasons, [
      "provider-active",
      "streaming-message",
      "turn-not-terminal",
    ]);
    assert.equal(thread.liveState.status, "active");
    assert.equal(thread.liveState.complete, false);
  } finally {
    cleanupFixture(fixture);
  }
});

test("an unrecognised turn state is treated as non-terminal", async () => {
  const fixture = createFixtureDatabase();
  try {
    setTurnState(fixture.databasePath, WINDOW_THREAD_ID, "wturn-3", "gremlin");

    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const thread = await client.getThread(WINDOW_THREAD_ID);

    assert.equal(thread.liveState.latestTurnState, "gremlin");
    assert.ok(thread.liveState.reasons.includes("turn-not-terminal"));
  } finally {
    cleanupFixture(fixture);
  }
});

test("a null or unresolved latest_turn_id falls back to the newest turn by ordering key", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });

    setThreadLatestTurn(fixture.databasePath, WINDOW_THREAD_ID, null);
    const nullFallback = await client.getThread(WINDOW_THREAD_ID);
    assert.equal(nullFallback.liveState.latestTurnId, "wturn-3");

    setThreadLatestTurn(fixture.databasePath, WINDOW_THREAD_ID, "no-such-turn");
    const unresolvedFallback = await client.getThread(WINDOW_THREAD_ID);
    assert.equal(unresolvedFallback.liveState.latestTurnId, "wturn-3");
  } finally {
    cleanupFixture(fixture);
  }
});

test("a bounded read reports the same liveState as a full read of the same thread", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath, now: FIXED_NOW });

    const fullRead = await client.getThread(WINDOW_THREAD_ID);
    const lastTurnRead = await client.getThread(WINDOW_THREAD_ID, { lastTurn: true });
    assert.deepEqual(fullRead.liveState, lastTurnRead.liveState);

    // An old window (the oldest turn, offset past the live turn) must still report the
    // thread's live state, not something derived from the selected window.
    const oldWindowRead = await client.getThread(WINDOW_THREAD_ID, { turnLimit: 1, turnOffset: 2 });
    assert.deepEqual(fullRead.liveState, oldWindowRead.liveState);
  } finally {
    cleanupFixture(fixture);
  }
});

test("observedAt is injectable, deterministic, and identical across reads with the same clock", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath, now: FIXED_NOW });

    const first = await client.getThread(ACTIVE_THREAD_ID);
    const second = await client.getThread(ACTIVE_THREAD_ID);

    assert.equal(first.liveState.observedAt, "2026-08-12T10:00:00.000Z");
    assert.equal(second.liveState.observedAt, "2026-08-12T10:00:00.000Z");
    assert.equal(first.liveState.observedAt, second.liveState.observedAt);
  } finally {
    cleanupFixture(fixture);
  }
});

test("liveState is present on every getThread() result", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });

    const fullRead = await client.getThread(ACTIVE_THREAD_ID);
    assert.ok(Object.hasOwn(fullRead, "liveState"));

    const boundedRead = await client.getThread(WINDOW_THREAD_ID, { lastTurn: true });
    assert.ok(Object.hasOwn(boundedRead, "liveState"));

    const orphanRead = await client.getThread(ORPHAN_THREAD_ID);
    assert.ok(Object.hasOwn(orphanRead, "liveState"));
    assert.equal(orphanRead.liveState.status, "unknown");
    assert.equal(orphanRead.liveState.complete, true);
    assert.deepEqual(orphanRead.liveState.reasons, []);
    assert.equal(orphanRead.liveState.providerStatus, null);
    assert.equal(orphanRead.liveState.latestTurnId, null);
    assert.equal(orphanRead.liveState.streamingMessageCount, 0);

    const emptyWindowRead = await client.getThread(WINDOW_THREAD_ID, { turnLimit: 1, turnOffset: 99 });
    assert.ok(Object.hasOwn(emptyWindowRead, "liveState"));
  } finally {
    cleanupFixture(fixture);
  }
});

test("a latest turn with a null state is treated as non-terminal", () => {
  const result = normalizeLiveState(
    { session: null, latestTurn: { turn_id: "t1", state: null }, streamingMessageCount: 0 },
    { observedAt: "2026-08-12T10:00:00.000Z" },
  );

  assert.deepEqual(result.reasons, ["turn-not-terminal"]);
  assert.equal(result.complete, false);
  assert.equal(result.latestTurnState, null);
});

test("turn state and provider status matching is case- and whitespace-insensitive", () => {
  assert.equal(isTerminalTurnState(" Completed "), true);
  assert.equal(isActiveProviderStatus("RUNNING"), true);

  const result = normalizeLiveState(
    {
      session: { status: "RUNNING" },
      latestTurn: { turn_id: "t1", state: " Completed " },
      streamingMessageCount: 0,
    },
    { observedAt: "2026-08-12T10:00:00.000Z" },
  );

  assert.deepEqual(result.reasons, ["provider-active"]);
});

test("every terminal turn state and active provider status is recognized, and unknown values are not", () => {
  for (const state of TERMINAL_TURN_STATES) {
    assert.equal(isTerminalTurnState(state), true, `expected "${state}" to be terminal`);
  }
  assert.equal(isTerminalTurnState("gremlin"), false);

  for (const status of ACTIVE_PROVIDER_STATUSES) {
    assert.equal(isActiveProviderStatus(status), true, `expected "${status}" to be active`);
  }
  assert.equal(isActiveProviderStatus("ready"), false);
});

test("live state is not inferred from timestamp recency", async () => {
  const fixture = createFixtureDatabase();
  try {
    const database = new DatabaseSync(fixture.databasePath);
    database
      .prepare("UPDATE projection_threads SET updated_at = ? WHERE thread_id = ?")
      .run("2026-08-12T09:59:59.999Z", ACTIVE_THREAD_ID);
    database.close();

    const client = await createT3ThreadClient({ db: fixture.databasePath, now: FIXED_NOW });
    const thread = await client.getThread(ACTIVE_THREAD_ID);

    assert.equal(thread.thread.updatedAt, "2026-08-12T09:59:59.999Z");
    assert.equal(thread.liveState.complete, true);
    assert.deepEqual(thread.liveState.reasons, []);
  } finally {
    cleanupFixture(fixture);
  }
});

test("liveState conforms to the schemas/thread.v1.json liveState contract", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const thread = await client.getThread(WINDOW_THREAD_ID);
    const liveStateSchema = threadSchema.properties.liveState;

    for (const key of liveStateSchema.required) {
      assert.ok(Object.hasOwn(thread.liveState, key), `missing required key "${key}"`);
    }
    for (const key of Object.keys(thread.liveState)) {
      assert.ok(Object.hasOwn(liveStateSchema.properties, key), `unexpected key "${key}"`);
    }
    assert.ok(liveStateSchema.properties.status.enum.includes(thread.liveState.status));
    for (const reason of thread.liveState.reasons) {
      assert.ok(liveStateSchema.properties.reasons.items.enum.includes(reason));
    }
  } finally {
    cleanupFixture(fixture);
  }
});
