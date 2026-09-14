import { VERSION } from "./version.js";

const SCHEMA_VERSION = "t3-thread.thread.v1";
const LIST_SCHEMA_VERSION = "t3-thread.list.v1";
const FIND_SCHEMA_VERSION = "t3-thread.find.v1";

// A turn state outside this set is treated as non-terminal, because reporting an
// unfinished thread as settled is the more damaging error.
export const TERMINAL_TURN_STATES = Object.freeze([
  "aborted",
  "canceled",
  "cancelled",
  "completed",
  "errored",
  "failed",
]);

export const ACTIVE_PROVIDER_STATUSES = Object.freeze([
  "active",
  "busy",
  "running",
  "streaming",
]);

export const LIVE_STATE_REASONS = Object.freeze([
  "provider-active",
  "streaming-message",
  "turn-not-terminal",
]);

const TERMINAL_TURN_STATE_SET = new Set(TERMINAL_TURN_STATES);
const ACTIVE_PROVIDER_STATUS_SET = new Set(ACTIVE_PROVIDER_STATUSES);

function normalizeStateToken(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : null;
}

export function isTerminalTurnState(state) {
  const token = normalizeStateToken(state);
  return token !== null && TERMINAL_TURN_STATE_SET.has(token);
}

export function isActiveProviderStatus(status) {
  const token = normalizeStateToken(status);
  return token !== null && ACTIVE_PROVIDER_STATUS_SET.has(token);
}

function warningFor(field, raw, error) {
  return {
    code: "MALFORMED_JSON",
    field,
    message: `Unable to parse ${field} as JSON.`,
    details: {
      raw,
      error: error instanceof Error ? error.message : String(error),
    },
  };
}

export function parseJsonField(raw, field, warnings) {
  if (raw === null || raw === undefined) {
    return { value: raw === undefined ? null : raw, malformed: false };
  }

  if (typeof raw !== "string") {
    return { value: raw, malformed: false };
  }

  try {
    return { value: JSON.parse(raw), malformed: false };
  } catch (error) {
    warnings.push(warningFor(field, raw, error));
    return { value: null, malformed: true, raw };
  }
}

function addAdapterSpecific(target, values) {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  if (entries.length > 0) {
    target.adapterSpecific = Object.fromEntries(entries);
  }
  return target;
}

function normalizeBoolean(value) {
  if (value === null || value === undefined) return value ?? null;
  if (value === true || value === false) return value;
  return value === 1 || value === "1" || value === "true";
}

function normalizeThreadMetadata(row) {
  const hasJoinMarker = Object.hasOwn(row, "project_join_id");
  const projectPresent = hasJoinMarker
    ? row.project_join_id !== null && row.project_join_id !== undefined
    : row.project_title !== null || row.workspace_root !== null;
  const project = !projectPresent
    ? null
    : {
        title: row.project_title ?? null,
        workspaceRoot: row.workspace_root ?? null,
      };

  return {
    id: row.thread_id,
    projectId: row.project_id ?? null,
    title: row.title ?? null,
    project,
    branch: row.branch ?? null,
    worktreePath: row.worktree_path ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    latestTurnId: row.latest_turn_id ?? null,
    latestUserMessageAt: row.latest_user_message_at ?? null,
    runtimeMode: row.runtime_mode ?? null,
    interactionMode: row.interaction_mode ?? null,
    modelSelection: row.modelSelection,
    workspaceRoot: row.workspace_root ?? null,
  };
}

function normalizeTurn(row, warnings) {
  const checkpointFiles = parseJsonField(
    row.checkpoint_files_json,
    `turns.${row.turn_id ?? row.row_id}.checkpointFiles`,
    warnings,
  );
  const normalized = {
    rowId: row.row_id ?? null,
    threadId: row.thread_id ?? null,
    turnId: row.turn_id ?? null,
    pendingMessageId: row.pending_message_id ?? null,
    sourceProposedPlanThreadId: row.source_proposed_plan_thread_id ?? null,
    sourceProposedPlanId: row.source_proposed_plan_id ?? null,
    assistantMessageId: row.assistant_message_id ?? null,
    state: row.state ?? null,
    requestedAt: row.requested_at ?? null,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    checkpointTurnCount: row.checkpoint_turn_count ?? null,
    checkpointRef: row.checkpoint_ref ?? null,
    checkpointStatus: row.checkpoint_status ?? null,
    checkpointFiles: checkpointFiles.value,
  };
  return addAdapterSpecific(normalized, checkpointFiles.malformed
    ? { checkpointFilesJson: checkpointFiles.raw }
    : {});
}

function normalizeMessage(row, warnings) {
  const attachments = parseJsonField(
    row.attachments_json,
    `messages.${row.message_id}.attachments`,
    warnings,
  );
  const normalized = {
    messageId: row.message_id,
    threadId: row.thread_id ?? null,
    turnId: row.turn_id ?? null,
    role: row.role ?? null,
    text: row.text ?? null,
    isStreaming: normalizeBoolean(row.is_streaming),
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    attachments: attachments.value,
  };
  return addAdapterSpecific(normalized, attachments.malformed
    ? { attachmentsJson: attachments.raw }
    : {});
}

function normalizeActivity(row, warnings) {
  const payload = parseJsonField(
    row.payload_json,
    `activities.${row.activity_id}.payload`,
    warnings,
  );
  const normalized = {
    activityId: row.activity_id,
    threadId: row.thread_id ?? null,
    turnId: row.turn_id ?? null,
    tone: row.tone ?? null,
    kind: row.kind ?? null,
    summary: row.summary ?? null,
    payload: payload.value,
    createdAt: row.created_at ?? null,
    sequence: row.sequence ?? null,
  };
  return addAdapterSpecific(normalized, payload.malformed
    ? { payloadJson: payload.raw }
    : {});
}

function normalizeProvider(row) {
  return {
    providerName: row?.provider_name ?? null,
    providerSessionId: row?.provider_session_id ?? null,
    providerThreadId: row?.provider_thread_id ?? null,
    providerInstanceId: row?.provider_instance_id ?? null,
    status: row?.status ?? null,
    lastError: row?.last_error ?? null,
    activeTurnId: row?.active_turn_id ?? null,
    runtimeMode: row?.runtime_mode ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

function projectFromJoinRow(row) {
  return row.project_join_id === null || row.project_join_id === undefined
    ? null
    : {
        title: row.project_title ?? null,
        workspaceRoot: row.workspace_root ?? null,
      };
}

export function normalizeThreadSearchResult(rows, { toolVersion = VERSION, title, reverse = false } = {}) {
  const threads = rows.map(normalizeThreadSummary);

  return {
    schemaVersion: FIND_SCHEMA_VERSION,
    toolVersion,
    filters: {
      title: typeof title === "string" ? title.trim() : (title ?? null),
    },
    ordering: {
      sortBy: "updatedAt",
      direction: reverse ? "desc" : "asc",
    },
    count: threads.length,
    threads,
  };
}

export function normalizeThreadSummary(row) {
  return {
    id: row.thread_id,
    projectId: row.project_id ?? null,
    title: row.title ?? null,
    project: projectFromJoinRow(row),
    branch: row.branch ?? null,
    worktreePath: row.worktree_path ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    latestUserMessageAt: row.latest_user_message_at ?? null,
    latestTurnId: row.latest_turn_id ?? null,
  };
}

// Live state describes the thread, not the retrieval window, so it is derived from a
// dedicated read rather than from whichever rows a bounded window happened to select.
// Recency of updated_at is deliberately not a signal.
export function normalizeLiveState(rows, { observedAt } = {}) {
  const session = rows?.session ?? null;
  const latestTurn = rows?.latestTurn ?? null;
  const streamingMessageCount = rows?.streamingMessageCount ?? 0;
  const providerStatus = session?.status ?? null;
  const reasons = [];

  if (latestTurn !== null && !isTerminalTurnState(latestTurn.state)) {
    reasons.push("turn-not-terminal");
  }
  if (streamingMessageCount > 0) {
    reasons.push("streaming-message");
  }
  if (isActiveProviderStatus(providerStatus)) {
    reasons.push("provider-active");
  }

  const sortedReasons = [...new Set(reasons)].sort();
  const hasSignal = session !== null || latestTurn !== null;

  return {
    status: sortedReasons.length > 0 ? "active" : hasSignal ? "idle" : "unknown",
    complete: sortedReasons.length === 0,
    observedAt: observedAt ?? new Date().toISOString(),
    providerStatus,
    latestTurnId: latestTurn?.turn_id ?? null,
    latestTurnState: latestTurn?.state ?? null,
    streamingMessageCount,
    reasons: sortedReasons,
  };
}

export function normalizeThreadList(rows, { toolVersion = VERSION, options, hasMore = false } = {}) {
  const threads = rows.map(normalizeThreadSummary);

  return {
    schemaVersion: LIST_SCHEMA_VERSION,
    toolVersion,
    filters: {
      project: options.project ?? null,
      since: options.since ?? null,
      before: options.before ?? null,
    },
    ordering: {
      sortBy: "updatedAt",
      direction: options.reverse ? "desc" : "asc",
    },
    limit: options.limit,
    offset: options.offset,
    count: threads.length,
    hasMore,
    threads,
  };
}

export function normalizeThread(rows, { toolVersion = VERSION, selection, observedAt } = {}) {
  const warnings = [];
  const modelSelection = parseJsonField(
    rows.thread.model_selection_json,
    "thread.modelSelection",
    warnings,
  );
  const thread = normalizeThreadMetadata({
    ...rows.thread,
    modelSelection: modelSelection.value,
  });
  if (modelSelection.malformed) {
    addAdapterSpecific(thread, { modelSelectionJson: modelSelection.raw });
  }

  const turns = rows.turns.map((row) => normalizeTurn(row, warnings));

  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    toolVersion,
    thread,
    turns,
    messages: rows.messages.map((row) => normalizeMessage(row, warnings)),
    activities: rows.activities.map((row) => normalizeActivity(row, warnings)),
    provider: normalizeProvider(rows.provider),
    liveState: normalizeLiveState(rows.liveState, { observedAt }),
    warnings,
  };

  if (selection !== null && selection !== undefined) {
    normalized.selection = {
      kind: selection.kind,
      turnId: selection.turnId ?? null,
      turnLimit: selection.turnLimit ?? null,
      turnOffset: selection.turnOffset ?? null,
      totalTurns: selection.totalTurns ?? null,
      selectedTurnIds: turns.map((turn) => turn.turnId).filter((turnId) => turnId !== null),
    };

    // An exact turn ID that resolved to nothing is ambiguous with a legitimately empty
    // window unless flagged explicitly. A turn-window offset past the end is a valid empty
    // page and stays silent.
    if (selection.kind === "turn" && turns.length === 0) {
      warnings.push({
        code: "TURN_NOT_FOUND",
        message: "No turn matched the requested turn ID.",
        details: { turnId: selection.turnId },
      });
    }
  }

  return normalized;
}

export { SCHEMA_VERSION, LIST_SCHEMA_VERSION, FIND_SCHEMA_VERSION };
