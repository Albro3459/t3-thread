import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createT3ThreadClient, openReadonlyDatabase } from "../src/index.js";
import { ACTIVE_THREAD_ID, createFixtureDatabase } from "./fixtures/sqlite-fixture.js";
import { enableWalMode } from "./fixtures/live-fixture.js";

function cleanupFixture(fixture) {
  fs.rmSync(fixture.directory, { recursive: true, force: true });
}

// The injected sleep is the only clock these tests use, so nothing depends on real time.
function createClock(startIso = "2026-08-12T10:00:00.000Z") {
  let value = Date.parse(startIso);
  return {
    now: () => value,
    advance(ms) {
      value += ms;
    },
  };
}

async function collect(iterable) {
  const records = [];
  for await (const record of iterable) {
    records.push(record);
  }
  return records;
}

test("opens a database read-only while a writer has a WAL", async () => {
  const fixture = createFixtureDatabase();
  const writer = new DatabaseSync(fixture.databasePath);
  try {
    const journalMode = writer.prepare("PRAGMA journal_mode = WAL").get().journal_mode;
    assert.equal(journalMode, "wal");
    writer.prepare(`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, created_at,
        updated_at, attachments_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "message-wal",
      ACTIVE_THREAD_ID,
      "turn-2",
      "assistant",
      "WAL-visible sanitized message",
      0,
      "2026-01-01T00:03:00.000Z",
      "2026-01-01T00:03:00.000Z",
      null,
    );

    assert.equal(fs.existsSync(`${fixture.databasePath}-wal`), true);
    assert.equal(fs.existsSync(`${fixture.databasePath}-shm`), true);

    const readonlyDatabase = openReadonlyDatabase(fixture.databasePath);
    try {
      assert.throws(
        () => readonlyDatabase.exec("CREATE TABLE should_not_be_created (id INTEGER)"),
        /readonly/i,
      );
      assert.equal(
        readonlyDatabase.prepare(
          "SELECT name FROM sqlite_schema WHERE name = 'should_not_be_created'",
        ).get(),
        undefined,
      );
    } finally {
      readonlyDatabase.close();
    }

    const client = await createT3ThreadClient({ db: fixture.databasePath });
    const thread = await client.getThread(ACTIVE_THREAD_ID);
    assert.equal(thread.messages.at(-1).messageId, "message-wal");
  } finally {
    writer.close();
    cleanupFixture(fixture);
  }
});

test("a tail observes rows another process commits in WAL mode on a later cycle", async () => {
  const fixture = createFixtureDatabase();
  assert.equal(enableWalMode(fixture.databasePath), "wal");
  const writer = new DatabaseSync(fixture.databasePath);
  try {
    const clock = createClock();
    const client = await createT3ThreadClient({ db: fixture.databasePath, now: clock.now });
    const records = await collect(client.tailThread(ACTIVE_THREAD_ID, {
      maxCycles: 2,
      // A separate connection commits between cycles; each cycle opens a fresh read-only
      // connection, so the commit becomes visible instead of being hidden by a stale snapshot.
      sleep: async (ms) => {
        clock.advance(ms);
        writer.prepare(`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, is_streaming, created_at,
            updated_at, attachments_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          "message-wal-tail",
          ACTIVE_THREAD_ID,
          "turn-2",
          "assistant",
          "WAL-visible sanitized tail message",
          0,
          "2026-01-01T00:04:00.000Z",
          "2026-01-01T00:04:00.000Z",
          null,
        );
      },
    }));

    assert.equal(fs.existsSync(`${fixture.databasePath}-wal`), true);
    const appended = records.filter(
      (record) => record.recordType === "message" && record.data.messageId === "message-wal-tail",
    );
    assert.equal(appended.length, 1);
    assert.equal(appended[0].cycle, 2);
    assert.equal(appended[0].op, "upsert");
  } finally {
    writer.close();
    cleanupFixture(fixture);
  }
});

test("a full tail run does not modify the database", async () => {
  const fixture = createFixtureDatabase();
  try {
    const before = fs.statSync(fixture.databasePath);

    const clock = createClock();
    const client = await createT3ThreadClient({ db: fixture.databasePath, now: clock.now });
    const records = await collect(client.tailThread(ACTIVE_THREAD_ID, {
      maxCycles: 3,
      sleep: async (ms) => clock.advance(ms),
    }));

    assert.equal(records.at(-1).data.reason, "max-cycles");
    const after = fs.statSync(fixture.databasePath);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally {
    cleanupFixture(fixture);
  }
});

test("a read-only connection still refuses writes while a tail is polling", async () => {
  const fixture = createFixtureDatabase();
  try {
    const clock = createClock();
    const client = await createT3ThreadClient({ db: fixture.databasePath, now: clock.now });
    let checked = false;

    await collect(client.tailThread(ACTIVE_THREAD_ID, {
      maxCycles: 2,
      sleep: async (ms) => {
        clock.advance(ms);
        const readonlyDatabase = openReadonlyDatabase(fixture.databasePath);
        try {
          assert.throws(
            () => readonlyDatabase.exec("CREATE TABLE should_not_be_created (id INTEGER)"),
            /readonly/iu,
          );
          assert.throws(
            () => readonlyDatabase
              .prepare("DELETE FROM projection_thread_messages WHERE thread_id = ?")
              .run(ACTIVE_THREAD_ID),
            /readonly/iu,
          );
          checked = true;
        } finally {
          readonlyDatabase.close();
        }
      },
    }));

    assert.equal(checked, true);
  } finally {
    cleanupFixture(fixture);
  }
});
