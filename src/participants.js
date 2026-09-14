import { parseJsonField } from "./normalize.js";
import { VERSION } from "./version.js";

export const PARTICIPANTS_SCHEMA_VERSION = "t3-thread.participants.v1";

export const TASK_ACTIVITY_KINDS = Object.freeze([
  "task.started",
  "task.progress",
  "task.completed",
  "task.updated",
]);

// A status outside this set is treated as non-terminal, because reporting a still-running
// agent as finished is the more damaging error.
export const TERMINAL_TASK_STATUSES = Object.freeze([
  "cancelled",
  "completed",
  "failed",
  "stopped",
]);

const TERMINAL_TASK_STATUS_SET = new Set(TERMINAL_TASK_STATUSES);

// Folded onto the participant as last-non-null-wins scalars. Everything else the projection
// carries lands in adapterSpecific instead of inventing top-level fields.
const SCALAR_FIELDS = Object.freeze([
  "title",
  "role",
  "model",
  "agentKind",
  "taskType",
  "effort",
  "status",
  "summary",
  "detail",
  "error",
  "toolUseId",
  "lastToolName",
  "workflowName",
  "outputFile",
  "isBackgrounded",
]);

const BOOLEAN_FIELDS = new Set(["isBackgrounded"]);

const CONSUMED_KEYS = new Set([...SCALAR_FIELDS, "taskId", "parentAgentId", "usage", "typedUsage"]);

// camelCase key on typedUsage, snake_case key on usage.
const USAGE_FIELDS = Object.freeze([
  ["totalTokens", "total_tokens"],
  ["toolUses", "tool_uses"],
  ["durationMs", "duration_ms"],
]);

export function isTerminalTaskStatus(status) {
  return typeof status === "string" && TERMINAL_TASK_STATUS_SET.has(status.trim().toLowerCase());
}

function taskState(status, hasStatusField) {
  if (!hasStatusField) return "unknown";
  return isTerminalTaskStatus(status) ? "finished" : "running";
}

// Unknown usage values stay null rather than becoming 0, so "not reported" and "zero" stay
// distinguishable.
function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Usage is folded per field, not as a whole object: a later task.progress that reports only
// totalTokens must not erase a toolUses that an earlier activity already reported.
function mergeUsage(target, source, snakeCase) {
  if (!source || typeof source !== "object") {
    return;
  }
  for (const [camel, snake] of USAGE_FIELDS) {
    const value = numberOrNull(source[snakeCase ? snake : camel]);
    if (value !== null) {
      target[camel] = value;
    }
  }
}

function emptyUsage() {
  return { totalTokens: null, toolUses: null, durationMs: null };
}

// The projection carries an identifier as a string, but a malformed payload must not emit a
// non-string taskId and break the tool's own schema.
function identifierOrNull(value) {
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return String(value);
  return null;
}

function stringOrNull(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint" || typeof value === "boolean") return String(value);
  return null;
}

// Null created_at sorts last, matching the shared ordering rule list and find use.
function compareActivityRows(a, b) {
  const left = a.created_at ?? null;
  const right = b.created_at ?? null;
  if (left === null && right !== null) return 1;
  if (left !== null && right === null) return -1;
  if (left !== null && right !== null && left !== right) return left < right ? -1 : 1;

  const leftSequence = a.sequence ?? null;
  const rightSequence = b.sequence ?? null;
  if (leftSequence !== rightSequence) {
    if (leftSequence === null) return 1;
    if (rightSequence === null) return -1;
    return leftSequence - rightSequence;
  }

  const leftId = a.activity_id ?? "";
  const rightId = b.activity_id ?? "";
  if (leftId < rightId) return -1;
  if (leftId > rightId) return 1;
  return 0;
}

// Direction-aware so a reversed listing cannot flip null firstSeenAt to the front: a null
// ordering timestamp sorts last in both directions.
function compareParticipants(a, b, reverse = false) {
  const left = a.firstSeenAt ?? null;
  const right = b.firstSeenAt ?? null;
  if (left === null && right !== null) return 1;
  if (left !== null && right === null) return -1;

  const flip = reverse ? -1 : 1;
  if (left !== null && right !== null && left !== right) {
    return (left < right ? -1 : 1) * flip;
  }
  if (a.taskId === b.taskId) return 0;
  return (a.taskId < b.taskId ? -1 : 1) * flip;
}

function alphabeticLabel(index) {
  let remaining = index;
  let label = "";
  do {
    label = String.fromCharCode(97 + (remaining % 26)) + label;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return label;
}

// Roots are numbered, their children lettered, and the pattern alternates by depth, so a
// path reads main.subagent1.subagent1a.subagent1a1.
function siblingSuffix(depth, index) {
  return depth % 2 === 0 ? String(index + 1) : alphabeticLabel(index);
}

function foldActivities(taskId, rows) {
  const participant = {
    taskId,
    parentTaskId: null,
    path: null,
    depth: 0,
  };
  for (const field of SCALAR_FIELDS) {
    participant[field] = null;
  }

  const turnIds = new Set();
  const adapterSpecific = {};
  const unusableScalars = {};
  const usableScalars = new Set();
  const typedUsage = emptyUsage();
  const usage = emptyUsage();
  let parentAgentId = null;
  let hasStatusField = false;
  let firstSeenAt = null;
  let lastSeenAt = null;
  let turnId = null;

  for (const { row, payload } of rows) {
    if (row.turn_id !== null && row.turn_id !== undefined) {
      turnIds.add(row.turn_id);
      if (turnId === null) {
        turnId = row.turn_id;
      }
    }
    if (row.created_at !== null && row.created_at !== undefined) {
      if (firstSeenAt === null) firstSeenAt = row.created_at;
      lastSeenAt = row.created_at;
    }

    if (!payload || typeof payload !== "object") {
      continue;
    }

    for (const field of SCALAR_FIELDS) {
      const raw = payload[field];
      if (raw === undefined || raw === null) {
        continue;
      }
      // A value of the wrong type is kept in adapterSpecific rather than emitted at the top
      // level, where it would violate the declared type in participants.v1.json.
      const value = BOOLEAN_FIELDS.has(field)
        ? (typeof raw === "boolean" ? raw : null)
        : stringOrNull(raw);
      if (value === null) {
        unusableScalars[field] = raw;
        continue;
      }
      participant[field] = value;
      usableScalars.add(field);
      if (field === "status") hasStatusField = true;
    }

    const resolvedParent = identifierOrNull(payload.parentAgentId);
    if (resolvedParent !== null) {
      parentAgentId = resolvedParent;
    }
    mergeUsage(typedUsage, payload.typedUsage, false);
    mergeUsage(usage, payload.usage, true);

    for (const [key, value] of Object.entries(payload)) {
      if (!CONSUMED_KEYS.has(key) && value !== undefined && value !== null) {
        adapterSpecific[key] = value;
      }
    }
  }

  participant.state = taskState(participant.status, hasStatusField);
  // The earliest turn the task was actually tagged with. An activity with a null turn_id
  // names no turn, so it is skipped rather than reported as an unknown turn.
  participant.turnId = turnId;
  participant.turnIds = [...turnIds].sort();
  participant.firstSeenAt = firstSeenAt;
  participant.lastSeenAt = lastSeenAt;
  participant.activityCount = rows.length;
  participant.usage = {
    totalTokens: typedUsage.totalTokens ?? usage.totalTokens,
    toolUses: typedUsage.toolUses ?? usage.toolUses,
    durationMs: typedUsage.durationMs ?? usage.durationMs,
  };

  // Resolved after the fold, not during it: a field that produced a usable value in any
  // activity belongs at the top level alone. Only a field that never resolved is preserved
  // in its raw projected form, so the same key can never appear in both places.
  for (const [field, raw] of Object.entries(unusableScalars)) {
    if (!usableScalars.has(field)) {
      adapterSpecific[field] = raw;
    }
  }

  if (Object.keys(adapterSpecific).length > 0) {
    participant.adapterSpecific = adapterSpecific;
  }

  return { participant, parentAgentId };
}

// Parentage comes only from an explicit, resolvable parentAgentId. Nothing here looks at
// timestamps, activity order, sequence, toolUseId, or identifier shape: two tasks that merely
// ran next to each other are two roots, and that is the correct answer.
//
// threadWideKnownTaskIds is null when no turn selection is active (the entries already cover
// the whole thread) and a Set of every taskId the thread has ever recorded when one is. A
// parentAgentId missing from the selected entries but present in that set names a real task
// whose own activities simply fall outside the window -- PARENT_OUT_OF_SELECTION, not
// UNRESOLVED_PARENT.
function resolveHierarchy(entries, warnings, threadWideKnownTaskIds) {
  const byTaskId = new Map(entries.map((entry) => [entry.participant.taskId, entry]));
  const outOfSelectionTaskIds = new Set();

  for (const entry of entries) {
    const { participant, parentAgentId } = entry;
    if (parentAgentId === null || parentAgentId === undefined) {
      continue;
    }

    if (!byTaskId.has(parentAgentId)) {
      if (threadWideKnownTaskIds !== null && threadWideKnownTaskIds.has(parentAgentId)) {
        participant.parentTaskId = parentAgentId;
        entry.outOfSelectionParent = true;
        outOfSelectionTaskIds.add(participant.taskId);
        continue;
      }

      warnings.push({
        code: "UNRESOLVED_PARENT",
        message: "A task recorded a parent that does not resolve to a known participant.",
        details: { taskId: participant.taskId, parentAgentId },
      });
      entry.unresolvedParent = true;
      continue;
    }

    participant.parentTaskId = parentAgentId;
  }

  if (outOfSelectionTaskIds.size > 0) {
    warnings.push({
      code: "PARENT_OUT_OF_SELECTION",
      message:
        "A recorded parent's activities fall outside the selected turns, so the child is reported at the top level.",
      details: { taskIds: [...outOfSelectionTaskIds].sort() },
    });
  }

  // A participant is in a cycle only when following its own parents leads back to itself, so
  // a task that merely sits downstream of a cycle keeps its own explicit edge. A self-parent
  // is a one-node cycle, not an unresolved parent: the identifier does resolve.
  const inCycle = new Set();
  for (const entry of entries) {
    const start = entry.participant.taskId;
    let current = entry.participant.parentTaskId;
    let steps = 0;
    while (current !== null && steps <= entries.length) {
      if (current === start) {
        inCycle.add(start);
        break;
      }
      current = byTaskId.get(current)?.participant.parentTaskId ?? null;
      steps += 1;
    }
  }

  if (inCycle.size > 0) {
    warnings.push({
      code: "PARENT_CYCLE",
      message: "Recorded task parentage contains a cycle; the affected tasks are reported as roots.",
      details: { taskIds: [...inCycle].sort() },
    });
    for (const taskId of inCycle) {
      byTaskId.get(taskId).participant.parentTaskId = null;
      byTaskId.get(taskId).cycleMember = true;
    }
  }

  return { byTaskId, outOfSelectionTaskIds };
}

function assignPathsAndDepths(entries) {
  const children = new Map();
  const roots = [];
  // A PARENT_OUT_OF_SELECTION entry carries a real parentTaskId that names a task outside
  // this set, so it must fall back to root here exactly as an unresolved or cyclic parent
  // does, rather than being filed under a parent this walk will never visit.
  const knownTaskIds = new Set(entries.map((entry) => entry.participant.taskId));

  for (const entry of entries) {
    const parentTaskId = entry.participant.parentTaskId;
    if (parentTaskId === null || !knownTaskIds.has(parentTaskId)) {
      roots.push(entry);
      continue;
    }
    if (!children.has(parentTaskId)) {
      children.set(parentTaskId, []);
    }
    children.get(parentTaskId).push(entry);
  }

  roots.sort((a, b) => compareParticipants(a.participant, b.participant));

  // Each label extends its parent's, and the path is every ancestor label under a synthetic
  // "main" root. ancestryKnown carries down the tree: an unresolved or cyclic ancestor makes
  // every descendant's position unknown too, so none of them get a path. The walk is
  // iterative so a pathologically deep chain cannot overflow the stack.
  const pending = roots.map((entry, index) => ({
    entry,
    depth: 0,
    label: `subagent${siblingSuffix(0, index)}`,
    ancestorSegments: [],
    ancestryKnown: true,
  }));

  while (pending.length > 0) {
    const { entry, depth, label, ancestorSegments, ancestryKnown } = pending.pop();
    const known = ancestryKnown && !entry.unresolvedParent && !entry.cycleMember
      && !entry.outOfSelectionParent;
    const segments = [...ancestorSegments, label];
    entry.participant.depth = depth;
    entry.participant.path = known ? ["main", ...segments].join(".") : null;

    const ownChildren = children.get(entry.participant.taskId) || [];
    ownChildren.sort((a, b) => compareParticipants(a.participant, b.participant));
    ownChildren.forEach((child, index) => {
      pending.push({
        entry: child,
        depth: depth + 1,
        label: `${label}${siblingSuffix(depth + 1, index)}`,
        ancestorSegments: segments,
        ancestryKnown: known,
      });
    });
  }

  return roots;
}

export function buildParticipantTree(participants) {
  const nodes = new Map(
    participants.map((participant) => [participant.taskId, { ...participant, children: [] }]),
  );
  const roots = [];

  for (const participant of participants) {
    const node = nodes.get(participant.taskId);
    const parent = participant.parentTaskId === null
      ? null
      : nodes.get(participant.parentTaskId) ?? null;
    // A child whose parent fell outside the selected page is surfaced at the root rather
    // than dropped; its parentTaskId still records the truth.
    if (parent === null) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }

  return roots;
}

export function normalizeParticipants(rows, {
  toolVersion = VERSION,
  threadId,
  options,
} = {}) {
  const warnings = [];

  // An exact turn ID that resolved to nothing is ambiguous with a legitimately empty view
  // unless flagged explicitly. A turn-window offset past the end is a valid empty page and
  // stays silent.
  if (rows.selection?.kind === "turn" && (rows.selection.selectedTurnIds?.length ?? 0) === 0) {
    warnings.push({
      code: "TURN_NOT_FOUND",
      message: "No turn matched the requested turn ID.",
      details: { turnId: rows.selection.turnId },
    });
  }

  const grouped = new Map();

  const activityRows = [...rows.activities].sort(compareActivityRows);
  for (const row of activityRows) {
    const parsed = parseJsonField(
      row.payload_json,
      `participants.${row.activity_id}.payload`,
      warnings,
    );
    const payload = parsed.value;
    const taskId = payload && typeof payload === "object"
      ? identifierOrNull(payload.taskId)
      : null;
    if (taskId === null) {
      continue;
    }
    if (!grouped.has(taskId)) {
      grouped.set(taskId, []);
    }
    grouped.get(taskId).push({ row, payload });
  }

  // Present only when a turn selection narrowed rows.activities above. Parsed with a scratch
  // warnings sink, not `warnings`: these payloads are outside the requested window purely to
  // build a membership set, so a malformed one out there must not surface a MALFORMED_JSON
  // warning for an activity the caller never asked to see.
  const threadWideKnownTaskIds = rows.unscopedActivities
    ? new Set(
        rows.unscopedActivities
          .map((row) => parseJsonField(row.payload_json, `participants.${row.activity_id}.payload`, []).value)
          .map((payload) => (payload && typeof payload === "object" ? identifierOrNull(payload.taskId) : null))
          .filter((taskId) => taskId !== null),
      )
    : null;

  const entries = [...grouped].map(([taskId, taskRows]) => foldActivities(taskId, taskRows));
  const { outOfSelectionTaskIds } = resolveHierarchy(entries, warnings, threadWideKnownTaskIds);
  assignPathsAndDepths(entries);

  // Sibling labels above are always assigned in ascending order, so --reverse changes the
  // display order without renumbering any path.
  const ordered = entries
    .map((entry) => entry.participant)
    .sort((a, b) => compareParticipants(a, b, options.reverse));

  const total = ordered.length;
  const withExplicitParent = ordered.filter((p) => p.parentTaskId !== null).length;
  const unresolvedParents = warnings.filter((w) => w.code === "UNRESOLVED_PARENT").length;
  const offset = options.offset ?? 0;
  const selected = options.limit === null || options.limit === undefined
    ? ordered.slice(offset)
    : ordered.slice(offset, offset + options.limit);

  // counts and hierarchyAvailable are computed from the selected turns (or the whole thread
  // when no selection is given), not from the --limit/--offset page below: paging only slices
  // what a tree can nest, it does not change what got counted.
  if (options.tree) {
    const pageTaskIds = new Set(selected.map((participant) => participant.taskId));
    const orphaned = selected
      .filter((p) => p.parentTaskId !== null && !pageTaskIds.has(p.parentTaskId)
        && !outOfSelectionTaskIds.has(p.taskId))
      .map((p) => p.taskId)
      .sort();
    if (orphaned.length > 0) {
      warnings.push({
        code: "PARENT_OUT_OF_PAGE",
        message:
          "Tree output is incomplete: these tasks have a resolved parent that limit or offset excluded, so they appear at the top level.",
        details: { taskIds: orphaned },
      });
    }
  }

  return {
    schemaVersion: PARTICIPANTS_SCHEMA_VERSION,
    toolVersion,
    threadId,
    ordering: { sortBy: "firstSeenAt", direction: options.reverse ? "desc" : "asc" },
    selection: rows.selection ?? null,
    counts: {
      total,
      participants: selected.length,
      roots: ordered.filter((p) => p.parentTaskId === null).length,
      withExplicitParent,
      unresolvedParents,
    },
    // Only true when a real edge resolved, so a consumer never presents a flat list as a tree.
    hierarchyAvailable: withExplicitParent > 0,
    participants: options.tree ? buildParticipantTree(selected) : selected,
    warnings,
  };
}
