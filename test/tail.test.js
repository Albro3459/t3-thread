import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  chronologicalThreadEntries,
  createT3ThreadClient,
  DatabaseUnavailableError,
  InvalidArgumentsError,
  ThreadNotFoundError,
} from "../src/index.js";
import { readThreadCycleFromDatabase } from "../src/sqlite-store.js";
import {
  appendMessage,
  deleteThread,
  setSessionStatus,
  setTurnState,
  updateMessage,
} from "./fixtures/live-fixture.js";
import {
  ACTIVE_THREAD_ID,
  createFixtureDatabase,
  WINDOW_THREAD_ID,
} from "./fixtures/sqlite-fixture.js";
import { assertMatchesSchema } from "./fixtures/schema-assert.js";

// Every test drives an injected now()/sleep() pair so nothing here depends on real
// elapsed time. sleep is also where fixture mutations happen between cycles.
function createClock(startIso = "2026-08-12T10:00:00.000Z") {
  let value = Date.parse(startIso);
  return {
    now: () => value,
    advance(ms) {
      value += ms;
    },
  };
}

function cleanupFixture(fixture) {
  fs.rmSync(fixture.directory, { recursive: true, force: true });
}

async function collect(iterable) {
  const records = [];
  for await (const record of iterable) {
    records.push(record);
  }
  return records;
}

test("--once emits a full baseline plus one live-state record and one end record", async () => {
  const fixture = createFixtureDatabase();
  try {
    const clock = createClock();
    const client = await createT3ThreadClient({ db: fixture.databasePath, now: clock.now });
    const records = await collect(client.tailThread(ACTIVE_THREAD_ID, { once: true }));

    const threadUpserts = records.filter((r) => r.recordType === "thread");
    const turnUpserts = records.filter((r) => r.recordType === "turn");
    const messageUpserts = records.filter((r) => r.recordType === "message");
    const activityUpserts = records.filter((r) => r.recordType === "activity");
    const liveStateRecords = records.filter((r) => r.op === "live-state");
    const endRecords = records.filter((r) => r.op === "end");

    // The fixture's ACTIVE_THREAD_ID has exactly 2 turns, 2 messages, and 2 activities.
    assert.equal(threadUpserts.length, 1);
    assert.equal(turnUpserts.length, 2);
    assert.equal(messageUpserts.length, 2);
    assert.equal(activityUpserts.length, 2);
    assert.equal(liveStateRecords.length, 1);
    assert.equal(endRecords.length, 1);
    assert.equal(endRecords[0].data.reason, "once");
    assert.equal(endRecords[0].data.cycles, 1);
    assert.equal(endRecords[0].cycle, 1);
    assert.equal(records.length, 1 + 2 + 2 + 2 + 1 + 1);
    assert.equal(records.at(-1), endRecords[0]);
    for (const record of records) {
      assert.equal(record.threadId, ACTIVE_THREAD_ID);
      assert.equal(record.cycle, 1);
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test("baseline data records within a cycle are in chronological order", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const thread = await client.getThread(ACTIVE_THREAD_ID);
    const expectedIds = chronologicalThreadEntries(thread).map((entry) => entry.identifier);

    const records = await collect(client.tailThread(ACTIVE_THREAD_ID, { once: true }));
    const dataRecords = records.filter(
      (r) => r.recordType === "turn" || r.recordType === "message" || r.recordType === "activity",
    );

    // Messages and activities also carry a turnId field pointing at their parent turn, so
    // the identifier must be picked by recordType rather than by nullish-coalescing.
    function identifierFor(record) {
      if (record.recordType === "turn") return record.data.turnId;
      if (record.recordType === "message") return record.data.messageId;
      return record.data.activityId;
    }

    assert.deepEqual(dataRecords.map(identifierFor), expectedIds);
    assert.deepEqual(expectedIds, ["turn-1", "turn-2", "message-1", "activity-1", "message-2", "activity-2"]);
  } finally {
    cleanupFixture(fixture);
  }
});

test("a message appended between cycles is a single upsert and is not re-emitted while unchanged", async () => {
  const fixture = createFixtureDatabase();
  try {
    const clock = createClock();
    const client = await createT3ThreadClient({ db: fixture.databasePath, now: clock.now });
    let sleepCalls = 0;
    const records = await collect(client.tailThread(ACTIVE_THREAD_ID, {
      maxCycles: 3,
      sleep: async (ms) => {
        clock.advance(ms);
        sleepCalls += 1;
        if (sleepCalls === 1) {
          appendMessage(fixture.databasePath, {
            messageId: "message-3",
            threadId: ACTIVE_THREAD_ID,
            turnId: "turn-2",
            role: "assistant",
            text: "Appended sanitized message",
            createdAt: "2026-01-01T00:03:00.000Z",
            updatedAt: "2026-01-01T00:03:00.000Z",
          });
        }
      },
    }));

    const appendedCycles = records
      .filter((r) => r.recordType === "message" && r.data.messageId === "message-3")
      .map((r) => r.cycle);
    assert.deepEqual(appendedCycles, [2]);

    const cycle3NonEnd = records.filter((r) => r.cycle === 3 && r.op !== "end");
    assert.equal(cycle3NonEnd.length, 0);
  } finally {
    cleanupFixture(fixture);
  }
});

test("a message whose text changes in place is re-emitted as upsert even though updated_at is unchanged", async () => {
  const fixture = createFixtureDatabase();
  try {
    const clock = createClock();
    const client = await createT3ThreadClient({ db: fixture.databasePath, now: clock.now });
    const records = await collect(client.tailThread(ACTIVE_THREAD_ID, {
      maxCycles: 2,
      sleep: async (ms) => {
        clock.advance(ms);
        updateMessage(fixture.databasePath, "message-1", { text: "Edited sanitized question" });
      },
    }));

    const cycle2Message = records.find(
      (r) => r.cycle === 2 && r.recordType === "message" && r.data.messageId === "message-1",
    );
    assert.ok(cycle2Message);
    assert.equal(cycle2Message.data.text, "Edited sanitized question");
    assert.equal(cycle2Message.data.updatedAt, "2026-01-01T00:01:00.000Z");
  } finally {
    cleanupFixture(fixture);
  }
});

test("a turn state change between cycles is emitted", async () => {
  const fixture = createFixtureDatabase();
  try {
    const clock = createClock();
    const client = await createT3ThreadClient({ db: fixture.databasePath, now: clock.now });
    const records = await collect(client.tailThread(ACTIVE_THREAD_ID, {
      maxCycles: 2,
      sleep: async (ms) => {
        clock.advance(ms);
        setTurnState(fixture.databasePath, ACTIVE_THREAD_ID, "turn-2", "errored");
      },
    }));

    const cycle2Turn = records.find(
      (r) => r.cycle === 2 && r.recordType === "turn" && r.data.turnId === "turn-2",
    );
    assert.ok(cycle2Turn);
    assert.equal(cycle2Turn.data.state, "errored");
  } finally {
    cleanupFixture(fixture);
  }
});

test("an unchanged cycle emits no data records", async () => {
  const fixture = createFixtureDatabase();
  try {
    const clock = createClock();
    const client = await createT3ThreadClient({ db: fixture.databasePath, now: clock.now });
    const records = await collect(client.tailThread(ACTIVE_THREAD_ID, {
      maxCycles: 2,
      sleep: async (ms) => clock.advance(ms),
    }));

    const cycle2Records = records.filter((r) => r.cycle === 2);
    assert.equal(cycle2Records.length, 1);
    assert.equal(cycle2Records[0].op, "end");
    assert.equal(cycle2Records[0].data.reason, "max-cycles");
  } finally {
    cleanupFixture(fixture);
  }
});

test("a live-state record is emitted in cycle 1 and again only when live state changes", async () => {
  const fixture = createFixtureDatabase();
  try {
    const clock = createClock();
    const client = await createT3ThreadClient({ db: fixture.databasePath, now: clock.now });
    let sleepCalls = 0;
    const records = await collect(client.tailThread(ACTIVE_THREAD_ID, {
      maxCycles: 3,
      sleep: async (ms) => {
        clock.advance(ms);
        sleepCalls += 1;
        if (sleepCalls === 2) {
          setSessionStatus(fixture.databasePath, ACTIVE_THREAD_ID, "running");
        }
      },
    }));

    const liveStateRecords = records.filter((r) => r.op === "live-state");
    // Cycle 2's live state is unchanged even though observedAt advanced, so it is not
    // re-emitted; only cycles 1 (baseline) and 3 (after the status change) appear.
    assert.deepEqual(liveStateRecords.map((r) => r.cycle), [1, 3]);
    assert.notDeepEqual(liveStateRecords[0].data.reasons, liveStateRecords[1].data.reasons);
    assert.notEqual(liveStateRecords[0].observedAt, liveStateRecords[1].observedAt);
  } finally {
    cleanupFixture(fixture);
  }
});

test("--max-cycles stops after exactly n cycles with reason max-cycles", async () => {
  const fixture = createFixtureDatabase();
  try {
    const clock = createClock();
    const client = await createT3ThreadClient({ db: fixture.databasePath, now: clock.now });
    const records = await collect(client.tailThread(ACTIVE_THREAD_ID, {
      maxCycles: 2,
      sleep: async (ms) => clock.advance(ms),
    }));

    const endRecords = records.filter((r) => r.op === "end");
    assert.equal(endRecords.length, 1);
    assert.equal(endRecords[0].data.reason, "max-cycles");
    assert.equal(endRecords[0].data.cycles, 2);
    assert.equal(endRecords[0].cycle, 2);
  } finally {
    cleanupFixture(fixture);
  }
});

test("--timeout stops with reason timeout using an injected clock", async () => {
  const fixture = createFixtureDatabase();
  try {
    const clock = createClock();
    const client = await createT3ThreadClient({ db: fixture.databasePath, now: clock.now });
    const records = await collect(client.tailThread(ACTIVE_THREAD_ID, {
      timeoutMs: 2500,
      intervalMs: 1000,
      sleep: async (ms) => clock.advance(ms),
    }));

    const endRecords = records.filter((r) => r.op === "end");
    assert.equal(endRecords.length, 1);
    assert.equal(endRecords[0].data.reason, "timeout");
  } finally {
    cleanupFixture(fixture);
  }
});

test("aborting through an AbortSignal during sleep yields exactly one end record with reason interrupt", async () => {
  const fixture = createFixtureDatabase();
  try {
    const clock = createClock();
    const controller = new AbortController();
    const client = await createT3ThreadClient({ db: fixture.databasePath, now: clock.now });
    const records = await collect(client.tailThread(ACTIVE_THREAD_ID, {
      signal: controller.signal,
      sleep: async (ms) => {
        clock.advance(ms);
        controller.abort();
      },
    }));

    assert.equal(records.filter((r) => r.op === "end").length, 1);
    assert.equal(records.at(-1).op, "end");
    assert.equal(records.at(-1).data.reason, "interrupt");
  } finally {
    cleanupFixture(fixture);
  }
});

test("an already-aborted signal yields exactly one end record before any cycle runs", async () => {
  const fixture = createFixtureDatabase();
  try {
    const controller = new AbortController();
    controller.abort();
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const records = await collect(client.tailThread(ACTIVE_THREAD_ID, { signal: controller.signal }));

    assert.equal(records.length, 1);
    assert.equal(records[0].op, "end");
    assert.equal(records[0].data.reason, "interrupt");
    assert.equal(records[0].data.cycles, 0);
    assert.equal(records[0].cycle, 0);
  } finally {
    cleanupFixture(fixture);
  }
});

test("a thread deleted mid-tail ends with reason thread-not-found and exit code 2", async () => {
  const fixture = createFixtureDatabase();
  try {
    const clock = createClock();
    const client = await createT3ThreadClient({ db: fixture.databasePath, now: clock.now });
    const tail = client.tailThread(ACTIVE_THREAD_ID, {
      sleep: async (ms) => {
        clock.advance(ms);
        deleteThread(fixture.databasePath, ACTIVE_THREAD_ID);
      },
    });

    const records = [];
    let caughtError = null;
    try {
      for await (const record of tail) {
        records.push(record);
      }
    } catch (error) {
      caughtError = error;
    }

    assert.ok(caughtError instanceof ThreadNotFoundError);
    assert.equal(caughtError.exitCode, 2);
    assert.equal(records.at(-1).op, "end");
    assert.equal(records.at(-1).data.reason, "thread-not-found");
  } finally {
    cleanupFixture(fixture);
  }
});

test("a thread missing on the first cycle throws without emitting an end record", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const tail = client.tailThread("missing-thread-0001", { once: true });

    const records = [];
    let caughtError = null;
    try {
      for await (const record of tail) {
        records.push(record);
      }
    } catch (error) {
      caughtError = error;
    }

    assert.ok(caughtError instanceof ThreadNotFoundError);
    assert.equal(caughtError.exitCode, 2);
    assert.deepEqual(records, []);
  } finally {
    cleanupFixture(fixture);
  }
});

test("three consecutive transient failures are retried with diagnostics and the fourth is fatal", async () => {
  const fixture = createFixtureDatabase();
  try {
    const clock = createClock();
    const client = await createT3ThreadClient({ db: fixture.databasePath, now: clock.now });
    const diagnostics = [];
    const tail = client.tailThread(ACTIVE_THREAD_ID, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      sleep: async (ms) => clock.advance(ms),
      readCycle: () => {
        throw new DatabaseUnavailableError("simulated transient failure", { operation: "test" });
      },
    });

    const records = [];
    let caughtError = null;
    try {
      for await (const record of tail) {
        records.push(record);
      }
    } catch (error) {
      caughtError = error;
    }

    assert.equal(diagnostics.length, 3);
    for (const diagnostic of diagnostics) {
      assert.equal(diagnostic.schemaVersion, "t3-thread.error.v1");
      assert.equal(diagnostic.code, "DATABASE_UNAVAILABLE");
    }
    assert.ok(caughtError instanceof DatabaseUnavailableError);
    assert.equal(caughtError.exitCode, 4);
    assert.equal(records.filter((r) => r.op === "end").length, 0);
  } finally {
    cleanupFixture(fixture);
  }
});

test("a transient failure followed by a success resets the consecutive-failure counter", async () => {
  const fixture = createFixtureDatabase();
  try {
    const clock = createClock();
    const client = await createT3ThreadClient({ db: fixture.databasePath, now: clock.now });
    let attempt = 0;
    const diagnostics = [];
    const records = await collect(client.tailThread(ACTIVE_THREAD_ID, {
      maxCycles: 7,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      sleep: async (ms) => clock.advance(ms),
      readCycle: (id, selection) => {
        attempt += 1;
        // Fails on cycles 1, 2, 4, 5, 6 and succeeds on 3 and 7: never four in a row.
        if (attempt === 3 || attempt === 7) {
          return readThreadCycleFromDatabase(fixture.databasePath, id, selection);
        }
        throw new DatabaseUnavailableError("simulated transient failure", { operation: "test" });
      },
    }));

    const endRecords = records.filter((r) => r.op === "end");
    assert.equal(endRecords.length, 1);
    assert.equal(endRecords[0].data.reason, "max-cycles");
    assert.equal(diagnostics.length, 5);
  } finally {
    cleanupFixture(fixture);
  }
});

test("--turn-limit bounds each cycle to the newest turns", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const records = await collect(client.tailThread(WINDOW_THREAD_ID, { once: true, turnLimit: 1 }));

    const turnUpserts = records.filter((r) => r.recordType === "turn");
    assert.equal(turnUpserts.length, 1);
    assert.equal(turnUpserts[0].data.turnId, "wturn-3");

    const threadUpsert = records.find((r) => r.recordType === "thread");
    assert.ok(threadUpsert.data.selection);
    assert.equal(threadUpsert.data.selection.turnLimit, 1);
  } finally {
    cleanupFixture(fixture);
  }
});

test("every emitted record validates against schemas/tail-record.v1.json", async () => {
  const schemaPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "schemas",
    "tail-record.v1.json",
  );
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));

  function assertValid(record) {
    assertMatchesSchema(record, schema, schema, "record");
  }

  const fixture = createFixtureDatabase();
  try {
    const clock = createClock();
    const client = await createT3ThreadClient({ db: fixture.databasePath, now: clock.now });
    const records = await collect(client.tailThread(ACTIVE_THREAD_ID, {
      maxCycles: 3,
      sleep: async (ms) => {
        clock.advance(ms);
        updateMessage(fixture.databasePath, "message-1", { text: "Edited again" });
      },
    }));

    assert.ok(records.length > 0);
    for (const record of records) {
      assertValid(record);
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test("tail never opens the provider JSONL log", async () => {
  const tailSourcePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "tail.js",
  );
  const tailSource = fs.readFileSync(tailSourcePath, "utf8");
  assert.ok(!tailSource.includes("provider-jsonl"));
  assert.ok(!tailSource.includes("providerLog"));

  const fixture = createFixtureDatabase();
  const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-thread-home-"));
  try {
    const providerLogDirectory = path.join(homeDirectory, "userdata", "logs", "provider");
    fs.mkdirSync(providerLogDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(providerLogDirectory, `events.${ACTIVE_THREAD_ID}.log`),
      "{ not valid json\n",
    );

    const client = await createT3ThreadClient({ home: homeDirectory, db: fixture.databasePath });
    const records = await collect(client.tailThread(ACTIVE_THREAD_ID, { once: true }));

    const endRecord = records.find((r) => r.op === "end");
    assert.equal(endRecord.data.reason, "once");
    // ACTIVE_THREAD_ID's fixture rows carry unrelated malformed-JSON warnings (message and
    // activity payload fields); what matters here is that none of them reference the
    // provider log the tail must never open.
    const threadUpsert = records.find((r) => r.recordType === "thread");
    assert.ok(!JSON.stringify(threadUpsert.data.warnings).toLowerCase().includes("provider"));
  } finally {
    cleanupFixture(fixture);
    fs.rmSync(homeDirectory, { recursive: true, force: true });
  }
});

test("invalid tail options are rejected synchronously before any iteration or SQLite access", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3ThreadClient({ db: fixture.databasePath });

    assert.throws(
      () => client.tailThread(ACTIVE_THREAD_ID, { once: true, maxCycles: 2 }),
      InvalidArgumentsError,
    );
    assert.throws(
      () => client.tailThread(ACTIVE_THREAD_ID, { intervalMs: 50 }),
      InvalidArgumentsError,
    );
    assert.throws(
      () => client.tailThread(ACTIVE_THREAD_ID, { intervalMs: 999999 }),
      InvalidArgumentsError,
    );
  } finally {
    cleanupFixture(fixture);
  }
});
