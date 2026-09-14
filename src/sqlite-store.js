import { DatabaseSync } from "node:sqlite";

import {
  DatabaseUnavailableError,
  InvalidArgumentsError,
  SchemaUnavailableError,
  ThreadNotFoundError,
} from "./errors.js";
import { TASK_ACTIVITY_KINDS } from "./participants.js";
import { normalizeListOptions } from "./query-options.js";

export const READ_TIMEOUT_MS = 250;

export const REQUIRED_TABLES = Object.freeze([
  "projection_threads",
  "projection_projects",
  "projection_thread_messages",
  "projection_thread_activities",
  "projection_thread_sessions",
  "projection_turns",
]);

export const REQUIRED_COLUMNS = Object.freeze({
  projection_threads: Object.freeze([
    "thread_id", "project_id", "title", "branch", "worktree_path", "latest_turn_id",
    "created_at", "updated_at", "latest_user_message_at", "deleted_at", "runtime_mode",
    "interaction_mode", "model_selection_json",
  ]),
  projection_projects: Object.freeze(["project_id", "title", "workspace_root"]),
  projection_thread_messages: Object.freeze([
    "message_id", "thread_id", "turn_id", "role", "text", "is_streaming", "created_at",
    "updated_at", "attachments_json",
  ]),
  projection_thread_activities: Object.freeze([
    "activity_id", "thread_id", "turn_id", "tone", "kind", "summary", "payload_json",
    "created_at", "sequence",
  ]),
  projection_thread_sessions: Object.freeze([
    "thread_id", "status", "provider_name", "provider_session_id", "provider_thread_id",
    "provider_instance_id", "last_error",
  ]),
  projection_turns: Object.freeze([
    "row_id", "thread_id", "turn_id", "pending_message_id", "assistant_message_id", "state",
    "requested_at", "started_at", "completed_at", "checkpoint_turn_count", "checkpoint_ref",
    "checkpoint_status", "checkpoint_files_json",
  ]),
});

const THREAD_QUERY = `
  SELECT
    t.thread_id,
    t.project_id,
    t.title,
    t.branch,
    t.worktree_path,
    t.latest_turn_id,
    t.created_at,
    t.updated_at,
    t.latest_user_message_at,
    t.deleted_at,
    t.runtime_mode,
    t.interaction_mode,
    t.model_selection_json,
    p.project_id AS project_join_id,
    p.title AS project_title,
    p.workspace_root
  FROM projection_threads AS t
  LEFT JOIN projection_projects AS p
    ON p.project_id = t.project_id
  WHERE t.thread_id = ?
    AND t.deleted_at IS NULL
`;

const MESSAGES_QUERY = `
  SELECT
    message_id,
    thread_id,
    turn_id,
    role,
    text,
    is_streaming,
    created_at,
    updated_at,
    attachments_json
  FROM projection_thread_messages
  WHERE thread_id = ?
  ORDER BY created_at, message_id
`;

const ACTIVITIES_QUERY = `
  SELECT
    activity_id,
    thread_id,
    turn_id,
    tone,
    kind,
    summary,
    payload_json,
    created_at,
    sequence
  FROM projection_thread_activities
  WHERE thread_id = ?
  ORDER BY created_at, activity_id
`;

const TURNS_QUERY = `
  SELECT *
  FROM projection_turns
  WHERE thread_id = ?
  ORDER BY row_id
`;

const PROVIDER_QUERY = `
  SELECT *
  FROM projection_thread_sessions
  WHERE thread_id = ?
`;

// Turns without a requested_at/started_at/completed_at value sort last in both directions,
// matching the null-updated_at rule used for thread ordering.
export const TURN_ORDER_KEY = "COALESCE(requested_at, started_at, completed_at)";

const TURN_BY_ID_QUERY = `
  SELECT *
  FROM projection_turns
  WHERE thread_id = ? AND turn_id = ?
  ORDER BY row_id
`;

const TURN_COUNT_QUERY = `
  SELECT COUNT(*) AS count
  FROM projection_turns
  WHERE thread_id = ?
`;

// Placeholders are generated from the frozen kind list's length; no value is interpolated.
const TASK_KIND_PLACEHOLDERS = TASK_ACTIVITY_KINDS.map(() => "?").join(", ");

const PARTICIPANT_ACTIVITIES_QUERY = `
  SELECT
    activity_id,
    thread_id,
    turn_id,
    kind,
    payload_json,
    created_at,
    sequence
  FROM projection_thread_activities
  WHERE thread_id = ? AND kind IN (${TASK_KIND_PLACEHOLDERS})
  ORDER BY (created_at IS NULL) ASC, created_at, sequence, activity_id
`;

function buildParticipantActivitiesByTurnQuery(turnCount) {
  return `
    SELECT
      activity_id,
      thread_id,
      turn_id,
      kind,
      payload_json,
      created_at,
      sequence
    FROM projection_thread_activities
    WHERE thread_id = ?
      AND kind IN (${TASK_KIND_PLACEHOLDERS})
      AND turn_id IN (${Array.from({ length: turnCount }, () => "?").join(", ")})
    ORDER BY (created_at IS NULL) ASC, created_at, sequence, activity_id
  `;
}

function buildTurnWindowQuery() {
  return `
    SELECT * FROM (
      SELECT *
      FROM projection_turns
      WHERE thread_id = ?
      ORDER BY (${TURN_ORDER_KEY} IS NULL) ASC, ${TURN_ORDER_KEY} DESC, row_id DESC
      LIMIT ? OFFSET ?
    )
    ORDER BY (${TURN_ORDER_KEY} IS NULL) ASC, ${TURN_ORDER_KEY} ASC, row_id ASC
  `;
}

const LIVE_STATE_SESSION_QUERY = `
  SELECT status
  FROM projection_thread_sessions
  WHERE thread_id = ?
`;

const LIVE_STATE_TURN_BY_ID_QUERY = `
  SELECT turn_id, state
  FROM projection_turns
  WHERE thread_id = ? AND turn_id = ?
  ORDER BY row_id DESC
  LIMIT 1
`;

const LIVE_STATE_NEWEST_TURN_QUERY = `
  SELECT turn_id, state
  FROM projection_turns
  WHERE thread_id = ?
  ORDER BY (${TURN_ORDER_KEY} IS NULL) ASC, ${TURN_ORDER_KEY} DESC, row_id DESC
  LIMIT 1
`;

// Matches the truthiness rule normalizeBoolean applies to is_streaming.
const STREAMING_MESSAGE_COUNT_QUERY = `
  SELECT COUNT(*) AS count
  FROM projection_thread_messages
  WHERE thread_id = ? AND is_streaming IN (1, '1', 'true')
`;

export function buildFindThreadsQuery(reverse) {
  const direction = reverse ? "DESC" : "ASC";
  return `
    SELECT
      t.thread_id,
      t.project_id,
      t.title,
      t.branch,
      t.worktree_path,
      t.latest_turn_id,
      t.created_at,
      t.updated_at,
      t.latest_user_message_at,
      p.project_id AS project_join_id,
      p.title AS project_title,
      p.workspace_root
    FROM projection_threads AS t
    LEFT JOIN projection_projects AS p
      ON p.project_id = t.project_id
    WHERE t.deleted_at IS NULL
      AND t.title COLLATE NOCASE LIKE '%' || ? || '%' ESCAPE '\\'
    ORDER BY (t.updated_at IS NULL) ASC, t.updated_at ${direction}, t.thread_id ${direction}
  `;
}

export function buildListThreadsQuery(options) {
  const direction = options.reverse ? "DESC" : "ASC";
  const clauses = ["t.deleted_at IS NULL"];
  const parameters = [];

  if (options.project !== null) {
    clauses.push("p.title COLLATE NOCASE = ?");
    parameters.push(options.project);
  }

  if (options.since !== null) {
    clauses.push("t.updated_at >= ?");
    parameters.push(options.since);
  }

  if (options.before !== null) {
    clauses.push("t.updated_at < ?");
    parameters.push(options.before);
  }

  const sql = `
    SELECT
      t.thread_id,
      t.project_id,
      t.title,
      t.branch,
      t.worktree_path,
      t.latest_turn_id,
      t.created_at,
      t.updated_at,
      t.latest_user_message_at,
      p.project_id AS project_join_id,
      p.title AS project_title,
      p.workspace_root
    FROM projection_threads AS t
    LEFT JOIN projection_projects AS p
      ON p.project_id = t.project_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY (t.updated_at IS NULL) ASC, t.updated_at ${direction}, t.thread_id ${direction}
    LIMIT ? OFFSET ?
  `;

  parameters.push(options.limit + 1, options.offset);

  return { sql, parameters };
}

const FIND_THREADS_QUERY = buildFindThreadsQuery(false);

export const SQL = Object.freeze({
  THREAD_QUERY,
  MESSAGES_QUERY,
  ACTIVITIES_QUERY,
  TURNS_QUERY,
  PROVIDER_QUERY,
  FIND_THREADS_QUERY,
  LIST_THREADS_QUERY: buildListThreadsQuery({
    project: null,
    since: null,
    before: null,
    limit: 50,
    offset: 0,
    reverse: false,
  }).sql,
});

function detailsFor(path, operation) {
  return { path, operation };
}

export function openReadonlyDatabase(databasePath) {
  try {
    return new DatabaseSync(databasePath, {
      readOnly: true,
      timeout: READ_TIMEOUT_MS,
    });
  } catch (error) {
    throw new DatabaseUnavailableError(
      `Unable to open the SQLite database: ${databasePath}`,
      detailsFor(databasePath, "open"),
      error,
    );
  }
}

export function listTables(database) {
  try {
    return database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .all()
      .map((row) => row.name);
  } catch (error) {
    throw new DatabaseUnavailableError(
      "Unable to inspect the SQLite database schema.",
      { operation: "list-tables" },
      error,
    );
  }
}

export function listColumns(database, table) {
  try {
    return database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name);
  } catch (error) {
    throw new DatabaseUnavailableError(
      `Unable to inspect the ${table} table schema.`,
      { operation: "list-columns", table },
      error,
    );
  }
}

export function inspectRequiredSchema(database) {
  const presentTables = listTables(database);
  const presentTableSet = new Set(presentTables);
  const missingTables = REQUIRED_TABLES.filter((table) => !presentTableSet.has(table));
  const presentColumns = {};
  const missingColumns = {};

  for (const table of REQUIRED_TABLES) {
    if (!presentTableSet.has(table)) {
      continue;
    }

    const columns = listColumns(database, table);
    presentColumns[table] = columns;
    const presentColumnSet = new Set(columns);
    const missing = REQUIRED_COLUMNS[table].filter((column) => !presentColumnSet.has(column));
    if (missing.length > 0) {
      missingColumns[table] = missing;
    }
  }

  return {
    valid: missingTables.length === 0 && Object.keys(missingColumns).length === 0,
    requiredTables: [...REQUIRED_TABLES],
    presentTables,
    missingTables,
    requiredColumns: REQUIRED_COLUMNS,
    presentColumns,
    missingColumns,
  };
}

export function validateRequiredTables(database) {
  const schema = inspectRequiredSchema(database);

  if (!schema.valid) {
    throw new SchemaUnavailableError(schema.missingTables, {
      operation: "validate-schema",
      requiredTables: schema.requiredTables,
      requiredColumns: schema.requiredColumns,
      missingColumns: schema.missingColumns,
    });
  }

  return Object.freeze({
    requiredTables: schema.requiredTables,
    presentTables: schema.presentTables,
    requiredColumns: schema.requiredColumns,
  });
}

function queryAll(database, sql, parameters, operation) {
  const values = Array.isArray(parameters) ? parameters : [parameters];
  try {
    return database.prepare(sql).all(...values);
  } catch (error) {
    throw new DatabaseUnavailableError(
      `Unable to retrieve ${operation} from the SQLite database.`,
      { operation },
      error,
    );
  }
}

// Runs `run` against an already-open database inside a read-only deferred transaction: BEGIN
// DEFERRED, validate the required schema, then the caller's read, with ROLLBACK and close
// guaranteed afterward. A BEGIN or ROLLBACK failure classifies as DatabaseUnavailableError the
// same way queryAll classifies a failed SELECT. If the read body already threw (a classified
// error or otherwise), a later ROLLBACK or close failure is swallowed rather than replacing it -
// the error already in flight always wins.
export function runReadTransaction(database, operation, run) {
  let transactionStarted = false;
  let inFlightError = null;
  let finallyError = null;

  try {
    try {
      database.exec("BEGIN DEFERRED");
      transactionStarted = true;
    } catch (error) {
      throw new DatabaseUnavailableError(
        `Unable to start a read transaction for ${operation}.`,
        { operation },
        error,
      );
    }

    validateRequiredTables(database);
    return run(database);
  } catch (error) {
    inFlightError = error;
    throw error;
  } finally {
    if (transactionStarted) {
      try {
        database.exec("ROLLBACK");
      } catch (error) {
        if (inFlightError === null) {
          finallyError = new DatabaseUnavailableError(
            `Unable to roll back the read transaction for ${operation}.`,
            { operation },
            error,
          );
        }
      }
    }

    try {
      database.close();
    } catch (error) {
      if (inFlightError === null && finallyError === null) {
        finallyError = new DatabaseUnavailableError(
          `Unable to close the SQLite database after ${operation}.`,
          { operation },
          error,
        );
      }
    }

    if (finallyError !== null) {
      throw finallyError;
    }
  }
}

// Opens a fresh read-only connection and delegates the transaction lifecycle to
// runReadTransaction. All five read paths in this module (readThreadFromDatabase,
// findThreadsFromDatabase, listThreadRowsFromDatabase, readThreadWindowFromDatabase,
// readParticipantActivitiesFromDatabase) route through this so none of them can bypass
// classification of a BEGIN/ROLLBACK/close failure.
function readWithTransaction(databasePath, operation, run) {
  const database = openReadonlyDatabase(databasePath);
  return runReadTransaction(database, operation, run);
}

function escapeLikeLiteral(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function normalizeTitleFilter(title) {
  if (typeof title !== "string") {
    throw new InvalidArgumentsError("find requires a title string.", { field: "title" });
  }

  const trimmed = title.trim();
  if (trimmed === "") {
    throw new InvalidArgumentsError("find requires a non-empty title string.", { field: "title" });
  }

  return trimmed;
}

// Resolves the thread's latest turn through latest_turn_id, falling back to the newest
// turn by the shared turn ordering key when that pointer is null or does not resolve.
export function retrieveLiveStateRows(database, threadId, latestTurnId = null) {
  const session = queryAll(database, LIVE_STATE_SESSION_QUERY, threadId, "live state session")[0]
    || null;

  let latestTurn = null;
  if (latestTurnId !== null && latestTurnId !== undefined) {
    latestTurn = queryAll(
      database,
      LIVE_STATE_TURN_BY_ID_QUERY,
      [threadId, latestTurnId],
      "live state turn",
    )[0] || null;
  }
  if (latestTurn === null) {
    latestTurn = queryAll(
      database,
      LIVE_STATE_NEWEST_TURN_QUERY,
      threadId,
      "live state turn",
    )[0] || null;
  }

  return {
    session,
    latestTurn,
    streamingMessageCount: queryAll(
      database,
      STREAMING_MESSAGE_COUNT_QUERY,
      threadId,
      "streaming message count",
    )[0].count,
  };
}

export function retrieveThreadRows(database, threadId) {
  const thread = queryAll(database, THREAD_QUERY, threadId, "thread")[0];
  if (!thread) {
    throw new ThreadNotFoundError(threadId);
  }

  return {
    thread,
    turns: queryAll(database, TURNS_QUERY, threadId, "turns"),
    messages: queryAll(database, MESSAGES_QUERY, threadId, "messages"),
    activities: queryAll(database, ACTIVITIES_QUERY, threadId, "activities"),
    provider: queryAll(database, PROVIDER_QUERY, threadId, "provider")[0] || null,
    liveState: retrieveLiveStateRows(database, threadId, thread.latest_turn_id),
  };
}

export function retrieveThreadSearchRows(database, title, { reverse = false } = {}) {
  const titleFilter = normalizeTitleFilter(title);
  const sql = reverse ? buildFindThreadsQuery(true) : FIND_THREADS_QUERY;
  return queryAll(
    database,
    sql,
    [escapeLikeLiteral(titleFilter)],
    "thread search",
  );
}

export function retrieveThreadListRows(database, listOptions) {
  const options = normalizeListOptions(listOptions);
  const { sql, parameters } = buildListThreadsQuery(options);
  const fetched = queryAll(database, sql, parameters, "thread list");
  return {
    rows: fetched.slice(0, options.limit),
    hasMore: fetched.length > options.limit,
  };
}

function uniqueIds(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined))];
}

// Shared by bounded thread retrieval and the bounded participant view so both windows mean
// exactly the same thing.
function selectTurnRows(database, threadId, selection) {
  return selection.kind === "turn"
    ? queryAll(database, TURN_BY_ID_QUERY, [threadId, selection.turnId], "turns")
    : queryAll(
        database,
        buildTurnWindowQuery(),
        [threadId, selection.turnLimit, selection.turnOffset],
        "turns",
      );
}

export function retrieveParticipantActivityRows(database, threadId, selection = null) {
  const thread = queryAll(database, THREAD_QUERY, threadId, "thread")[0];
  if (!thread) {
    throw new ThreadNotFoundError(threadId);
  }

  if (selection === null || selection === undefined) {
    return {
      thread,
      activities: queryAll(
        database,
        PARTICIPANT_ACTIVITIES_QUERY,
        [threadId, ...TASK_ACTIVITY_KINDS],
        "participant activities",
      ),
      selection: null,
    };
  }

  const turns = selectTurnRows(database, threadId, selection);
  const totalTurns = queryAll(database, TURN_COUNT_QUERY, threadId, "turn count")[0].count;
  const turnIds = uniqueIds(turns.map((turn) => turn.turn_id));
  const activities = turnIds.length === 0
    ? []
    : queryAll(
        database,
        buildParticipantActivitiesByTurnQuery(turnIds.length),
        [threadId, ...TASK_ACTIVITY_KINDS, ...turnIds],
        "participant activities",
      );

  // A selection narrows which activities come back, but a parent task's own activities can
  // live in a turn outside the window. participants.js needs the thread-wide set of known
  // task IDs to tell that case apart from a genuinely unresolved parent, so read the same
  // task activity payloads again unscoped. Payload parsing stays in participants.js (its
  // tolerant JS parser degrades with a warning on malformed JSON; json_extract would throw).
  const unscopedActivities = queryAll(
    database,
    PARTICIPANT_ACTIVITIES_QUERY,
    [threadId, ...TASK_ACTIVITY_KINDS],
    "participant activities",
  );

  return {
    thread,
    activities,
    unscopedActivities,
    selection: {
      kind: selection.kind,
      turnId: selection.turnId ?? null,
      turnLimit: selection.turnLimit ?? null,
      turnOffset: selection.turnOffset ?? null,
      totalTurns,
      selectedTurnIds: turnIds,
    },
  };
}

export function readParticipantActivitiesFromDatabase(databasePath, threadId, selection = null) {
  return readWithTransaction(
    databasePath,
    "participant activities",
    (database) => retrieveParticipantActivityRows(database, threadId, selection),
  );
}

export function retrieveThreadWindowRows(database, threadId, selection) {
  const thread = queryAll(database, THREAD_QUERY, threadId, "thread")[0];
  if (!thread) {
    throw new ThreadNotFoundError(threadId);
  }

  const totalTurns = queryAll(database, TURN_COUNT_QUERY, threadId, "turn count")[0].count;

  const turns = selectTurnRows(database, threadId, selection);

  const turnIds = uniqueIds(turns.map((turn) => turn.turn_id));
  const messageIds = uniqueIds(turns.flatMap((turn) => [turn.pending_message_id, turn.assistant_message_id]));

  const messages = [];
  let activities = [];

  if (turnIds.length > 0 || messageIds.length > 0) {
    const messageClauses = [];
    const messageParameters = [threadId];
    if (turnIds.length > 0) {
      messageClauses.push(`turn_id IN (${turnIds.map(() => "?").join(", ")})`);
      messageParameters.push(...turnIds);
    }
    if (messageIds.length > 0) {
      messageClauses.push(`message_id IN (${messageIds.map(() => "?").join(", ")})`);
      messageParameters.push(...messageIds);
    }

    const messagesSql = `
      SELECT
        message_id,
        thread_id,
        turn_id,
        role,
        text,
        is_streaming,
        created_at,
        updated_at,
        attachments_json
      FROM projection_thread_messages
      WHERE thread_id = ? AND (${messageClauses.join(" OR ")})
      ORDER BY (created_at IS NULL) ASC, created_at, message_id
    `;
    const fetchedMessages = queryAll(database, messagesSql, messageParameters, "messages");
    const seenMessageIds = new Set();
    for (const row of fetchedMessages) {
      if (!seenMessageIds.has(row.message_id)) {
        seenMessageIds.add(row.message_id);
        messages.push(row);
      }
    }

    if (turnIds.length > 0) {
      const activitiesSql = `
        SELECT
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at,
          sequence
        FROM projection_thread_activities
        WHERE thread_id = ? AND turn_id IN (${turnIds.map(() => "?").join(", ")})
        ORDER BY (created_at IS NULL) ASC, created_at, activity_id
      `;
      activities = queryAll(database, activitiesSql, [threadId, ...turnIds], "activities");
    }
  }

  return {
    thread,
    turns,
    messages,
    activities,
    provider: queryAll(database, PROVIDER_QUERY, threadId, "provider")[0] || null,
    liveState: retrieveLiveStateRows(database, threadId, thread.latest_turn_id),
    selection: {
      kind: selection.kind,
      turnId: selection.turnId ?? null,
      turnLimit: selection.turnLimit ?? null,
      turnOffset: selection.turnOffset ?? null,
      totalTurns,
    },
  };
}

export function countProjectionRows(database) {
  const count = (table, operation) => queryAll(
    database,
    `SELECT COUNT(*) AS count FROM ${table}`,
    [],
    operation,
  )[0].count;

  return {
    threads: count("projection_threads", "thread count"),
    messages: count("projection_thread_messages", "message count"),
    activities: count("projection_thread_activities", "activity count"),
  };
}

export function readThreadFromDatabase(databasePath, threadId) {
  return readWithTransaction(
    databasePath,
    "thread",
    (database) => retrieveThreadRows(database, threadId),
  );
}

export function findThreadsFromDatabase(databasePath, title, { reverse = false } = {}) {
  const titleFilter = normalizeTitleFilter(title);
  return readWithTransaction(
    databasePath,
    "thread search",
    (database) => retrieveThreadSearchRows(database, titleFilter, { reverse }),
  );
}

export function listThreadRowsFromDatabase(databasePath, options) {
  const listOptions = normalizeListOptions(options);
  return readWithTransaction(
    databasePath,
    "thread list",
    (database) => retrieveThreadListRows(database, listOptions),
  );
}

// One tail cycle: the same row shape the full and windowed reads return, so a tail and a
// get normalize identically. Each call opens, reads in a deferred transaction, and closes,
// because a long-lived snapshot would never observe another process's WAL commits.
export function readThreadCycleFromDatabase(databasePath, threadId, selection = null) {
  return selection === null || selection === undefined
    ? readThreadFromDatabase(databasePath, threadId)
    : readThreadWindowFromDatabase(databasePath, threadId, selection);
}

export function readThreadWindowFromDatabase(databasePath, threadId, selection) {
  if (selection === null || selection === undefined) {
    throw new InvalidArgumentsError("A turn selection is required.", { field: "selection" });
  }

  return readWithTransaction(
    databasePath,
    "thread window",
    (database) => retrieveThreadWindowRows(database, threadId, selection),
  );
}
