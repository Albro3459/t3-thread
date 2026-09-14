import { setTimeout as delay } from "node:timers/promises";

import { serializeError, ThreadNotFoundError } from "./errors.js";
import { normalizeThread } from "./normalize.js";
import { normalizeTailOptions } from "./query-options.js";
import { chronologicalThreadEntries } from "./record-order.js";
import { readThreadCycleFromDatabase } from "./sqlite-store.js";
import { VERSION } from "./version.js";

export const TAIL_SCHEMA_VERSION = "t3-thread.tail-record.v1";

export const TAIL_OPERATIONS = Object.freeze(["upsert", "live-state", "end"]);

export const TAIL_RECORD_TYPES = Object.freeze([
  "thread",
  "turn",
  "message",
  "activity",
  "live-state",
  "end",
]);

export const TAIL_END_REASONS = Object.freeze([
  "once",
  "max-cycles",
  "timeout",
  "interrupt",
  "thread-not-found",
]);

export const MAX_CONSECUTIVE_READ_FAILURES = 3;

async function defaultSleep(ms, { signal } = {}) {
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      return;
    }
    throw error;
  }
}

function entityKey(type, record) {
  if (type === "turn") {
    return `turn:${record.turnId ?? record.rowId}`;
  }
  if (type === "message") {
    return `message:${record.messageId}`;
  }
  return `activity:${record.activityId}`;
}

function threadRecordData(thread) {
  const data = { thread: thread.thread, provider: thread.provider, warnings: thread.warnings };
  if (thread.selection !== undefined) {
    data.selection = thread.selection;
  }
  return data;
}

// observedAt is excluded from the live-state comparison value because it advances every
// cycle regardless of whether anything else changed, and would otherwise never let a
// live-state record settle into "unchanged".
function liveStateCompareValue(liveState) {
  const { observedAt, ...rest } = liveState;
  void observedAt;
  return rest;
}

function buildRecord({ op, recordType, threadId, observedAt, cycle, data }) {
  return { schemaVersion: TAIL_SCHEMA_VERSION, op, recordType, threadId, observedAt, cycle, data };
}

// Diffs the current cycle's records against the previous cycle's serialized state and
// yields upserts for anything new or changed, in chronological order, followed by the
// live-state record if it changed. The state map is rebuilt from scratch every cycle
// (rather than merged into), so memory stays bounded by the current thread size or, under
// --turn-limit, by the current window size. A consequence is that a record which leaves a
// bounded window and later re-enters it is treated as unseen and re-emitted as upsert; that
// is harmless because upsert means replace-by-identifier, not append.
function* runCycle(thread, { threadId, observedAt, cycle, previousState }) {
  const nextState = new Map();

  const threadEntryKey = `thread:${thread.thread.id}`;
  const threadData = threadRecordData(thread);
  const threadSerialized = JSON.stringify(threadData);
  nextState.set(threadEntryKey, threadSerialized);
  if (previousState.get(threadEntryKey) !== threadSerialized) {
    yield buildRecord({
      op: "upsert",
      recordType: "thread",
      threadId,
      observedAt,
      cycle,
      data: threadData,
    });
  }

  for (const entry of chronologicalThreadEntries(thread)) {
    const key = entityKey(entry.type, entry.record);
    const serialized = JSON.stringify(entry.record);
    nextState.set(key, serialized);
    if (previousState.get(key) !== serialized) {
      yield buildRecord({
        op: "upsert",
        recordType: entry.type,
        threadId,
        observedAt,
        cycle,
        data: entry.record,
      });
    }
  }

  const liveStateKey = "live-state";
  const liveStateSerialized = JSON.stringify(liveStateCompareValue(thread.liveState));
  nextState.set(liveStateKey, liveStateSerialized);
  if (previousState.get(liveStateKey) !== liveStateSerialized) {
    yield buildRecord({
      op: "live-state",
      recordType: "live-state",
      threadId,
      observedAt,
      cycle,
      data: thread.liveState,
    });
  }

  previousState.clear();
  for (const [key, value] of nextState) {
    previousState.set(key, value);
  }
}

// Yields t3-thread.tail-record.v1 objects and always terminates with exactly one end
// record (the sole exception being the fatal fourth consecutive read failure, which throws
// DatabaseUnavailableError instead, since no end reason exists for a database that never
// recovers). Each cycle opens a fresh read-only connection through readCycle, so a
// long-lived snapshot never hides another process's WAL commits.
export async function* tailThreadRecords(threadId, {
  databasePath,
  tailOptions = normalizeTailOptions({}),
  toolVersion = VERSION,
  signal,
  now = Date.now,
  sleep = defaultSleep,
  onDiagnostic,
  readCycle,
} = {}) {
  const doReadCycle = typeof readCycle === "function"
    ? readCycle
    : (id, selection) => readThreadCycleFromDatabase(databasePath, id, selection);

  const previousState = new Map();
  const startedAt = now();
  let cycle = 0;
  let failures = 0;
  let lastObservedAt = null;

  function endRecord(reason) {
    return buildRecord({
      op: "end",
      recordType: "end",
      threadId,
      observedAt: lastObservedAt ?? new Date(now()).toISOString(),
      cycle,
      data: { reason, cycles: cycle },
    });
  }

  for (;;) {
    if (signal?.aborted) {
      yield endRecord("interrupt");
      return;
    }

    cycle += 1;
    const observedAt = new Date(now()).toISOString();
    lastObservedAt = observedAt;

    try {
      const rows = doReadCycle(threadId, tailOptions.selection);
      const thread = normalizeThread(rows, {
        toolVersion,
        selection: rows.selection,
        observedAt,
      });
      failures = 0;

      yield* runCycle(thread, { threadId, observedAt, cycle, previousState });

      if (tailOptions.once) {
        yield endRecord("once");
        return;
      }
    } catch (error) {
      if (error instanceof ThreadNotFoundError) {
        // A thread that disappears mid-tail ends the stream with a reason. A thread that was
        // already missing on the first cycle is a plain startup failure and must behave
        // exactly like get: the error only, nothing on stdout.
        if (cycle > 1) {
          yield endRecord("thread-not-found");
        }
        throw error;
      }

      failures += 1;
      if (failures > MAX_CONSECUTIVE_READ_FAILURES) {
        throw error;
      }
      onDiagnostic?.(serializeError(error));
    }

    if (tailOptions.maxCycles !== null && cycle >= tailOptions.maxCycles) {
      yield endRecord("max-cycles");
      return;
    }
    if (tailOptions.timeoutMs !== null && now() - startedAt >= tailOptions.timeoutMs) {
      yield endRecord("timeout");
      return;
    }

    await sleep(tailOptions.intervalMs, { signal });

    if (signal?.aborted) {
      yield endRecord("interrupt");
      return;
    }
    if (tailOptions.timeoutMs !== null && now() - startedAt >= tailOptions.timeoutMs) {
      yield endRecord("timeout");
      return;
    }
  }
}
