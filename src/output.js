import { chronologicalThreadEntries } from "./record-order.js";

const JSONL_SCHEMA_VERSION = "t3-thread.jsonl-record.v1";

function displayValue(value) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}

function addField(lines, label, value) {
  lines.push(`${label}: ${displayValue(value)}`);
}

// Unlike addField, this omits the line entirely rather than printing a "-" placeholder for
// null. Used for the enriched participant fields, where 261-participant threads make a stray
// null line a real cost.
function addCompactLine(lines, prefix, parts) {
  const rendered = parts.filter(([, value]) => value !== null && value !== undefined && value !== "");
  if (rendered.length === 0) {
    return;
  }
  lines.push(`${prefix}${rendered.map(([label, value]) => `${label}: ${value}`).join(", ")}`);
}

// One decimal place under a minute, minutes+seconds above it -- both stay compact and neither
// requires a locale-aware formatter.
function formatDurationMs(durationMs) {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
    return null;
  }
  const totalSeconds = durationMs / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${seconds}s`;
}

// Summary/detail can run to hundreds of characters with embedded newlines in real data; only
// the first line, truncated, is safe to fold into the indented tree layout.
function summaryPreview(text, maxLength = 140) {
  if (typeof text !== "string") {
    return null;
  }
  const firstLine = text.split("\n")[0].trim();
  if (firstLine.length === 0) {
    return null;
  }
  return firstLine.length > maxLength ? `${firstLine.slice(0, maxLength - 1)}…` : firstLine;
}

function sectionHeading(title) {
  return [title, "-".repeat(title.length)];
}

function formatMessage(message) {
  const timestamp = message.createdAt || message.updatedAt || "unknown time";
  const role = message.role || "unknown role";
  const turn = message.turnId ? ` [${message.turnId}]` : "";
  const text = message.text ?? "";
  const textLines = String(text).split("\n");
  const lines = [`[${timestamp}] ${role}${turn}`];
  lines.push(...textLines.map((line) => `  ${line}`));
  return lines;
}

function formatActivity(activity) {
  const timestamp = activity.createdAt || "unknown time";
  const tone = activity.tone ? ` [${activity.tone}]` : "";
  const kind = activity.kind || "activity";
  const turn = activity.turnId ? ` (${activity.turnId})` : "";
  return `- [${timestamp}]${tone} ${kind}${turn}: ${activity.summary ?? ""}`;
}

export function formatThreadHuman(thread) {
  const bounded = thread.selection != null;
  const lines = ["Thread", "======", ""];
  addField(lines, "ID", thread.thread.id);
  addField(lines, "Title", thread.thread.title);
  addField(lines, "Project ID", thread.thread.projectId);
  addField(lines, "Project", thread.thread.project?.title);
  addField(lines, "Workspace root", thread.thread.workspaceRoot);
  addField(lines, "Branch", thread.thread.branch);
  addField(lines, "Worktree", thread.thread.worktreePath);
  addField(lines, "Created", thread.thread.createdAt);
  addField(lines, "Updated", thread.thread.updatedAt);
  addField(lines, "Latest user message", thread.thread.latestUserMessageAt);
  addField(lines, "Latest turn", thread.thread.latestTurnId);
  addField(lines, "Runtime mode", thread.thread.runtimeMode);
  addField(lines, "Interaction mode", thread.thread.interactionMode);
  addField(lines, "Model selection", thread.thread.modelSelection);

  lines.push("", "Provider", "--------");
  addField(lines, "Name", thread.provider.providerName);
  addField(lines, "Session ID", thread.provider.providerSessionId);
  addField(lines, "Thread ID", thread.provider.providerThreadId);
  addField(lines, "Instance ID", thread.provider.providerInstanceId);
  addField(lines, "Status", thread.provider.status);
  addField(lines, "Last error", thread.provider.lastError);

  if (thread.liveState) {
    lines.push("", "Live state", "----------");
    addField(lines, "Status", thread.liveState.status);
    lines.push(`Complete: ${thread.liveState.complete ? "yes" : "no"}`);
    addField(lines, "Observed", thread.liveState.observedAt);
    addField(lines, "Provider status", thread.liveState.providerStatus);
    addField(lines, "Latest turn", thread.liveState.latestTurnId);
    addField(lines, "Latest turn state", thread.liveState.latestTurnState);
    addField(lines, "Streaming messages", thread.liveState.streamingMessageCount);
    addField(lines, "Reasons", thread.liveState.reasons.join(", "));
  }

  if (bounded) {
    lines.push("", "Selection", "---------");
    addField(lines, "Kind", thread.selection.kind);
    addField(lines, "Turn ID", thread.selection.turnId);
    addField(lines, "Turn limit", thread.selection.turnLimit);
    addField(lines, "Turn offset", thread.selection.turnOffset);
    addField(lines, "Total turns", thread.selection.totalTurns);
    addField(lines, "Selected turns", thread.selection.selectedTurnIds.join(", "));
    lines.push("Partial history: yes");
  }

  lines.push("", ...sectionHeading(bounded ? "Turns (partial)" : "Turns"));
  if (thread.turns.length === 0) {
    lines.push("- None");
  } else {
    for (const turn of thread.turns) {
      const state = turn.state || "unknown state";
      const timing = turn.completedAt || turn.startedAt || turn.requestedAt || "unknown time";
      lines.push(`- ${turn.turnId || "unknown turn"} [${state}] ${timing}`);
    }
  }

  lines.push("", ...sectionHeading(bounded ? "Messages (partial)" : "Messages"));
  if (thread.messages.length === 0) {
    lines.push("- None");
  } else {
    for (const message of thread.messages) {
      lines.push(...formatMessage(message));
    }
  }

  lines.push("", ...sectionHeading(bounded ? "Activities (partial)" : "Activities"));
  if (thread.activities.length === 0) {
    lines.push("- None");
  } else {
    lines.push(...thread.activities.map(formatActivity));
  }

  if (thread.warnings.length > 0) {
    lines.push("", "Warnings", "--------");
    for (const warning of thread.warnings) {
      lines.push(`- ${warning.code}: ${warning.message}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function formatThreadJson(thread) {
  return `${JSON.stringify(thread, null, 2)}\n`;
}

export function formatFindJson(result) {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export function formatFindHuman(result) {
  const lines = ["Threads", "=======", ""];
  addField(lines, "Title", result.filters.title);
  lines.push(`Order: ${result.ordering.sortBy} ${result.ordering.direction}`);
  addField(lines, "Returned", result.count);
  lines.push("");

  if (result.threads.length === 0) {
    lines.push("No matching threads.");
    return `${lines.join("\n")}\n`;
  }

  for (const thread of result.threads) {
    lines.push(
      `${thread.title || "(untitled)"}`,
      `  ID: ${thread.id}`,
      `  Project: ${thread.project?.title || "-"}`,
      `  Updated: ${thread.updatedAt || "-"}`,
      `  Created: ${thread.createdAt || "-"}`,
      "",
    );
  }

  return `${lines.join("\n")}\n`;
}

export function formatListJson(list) {
  return `${JSON.stringify(list, null, 2)}\n`;
}

export function formatListHuman(list) {
  const lines = ["Threads", "=======", ""];
  addField(lines, "Project", list.filters.project);
  addField(lines, "Since", list.filters.since);
  addField(lines, "Before", list.filters.before);
  lines.push(`Order: ${list.ordering.sortBy} ${list.ordering.direction}`);
  addField(lines, "Limit", list.limit);
  addField(lines, "Offset", list.offset);
  addField(lines, "Returned", list.count);
  lines.push(`More available: ${list.hasMore ? "yes" : "no"}`, "");

  if (list.threads.length === 0) {
    lines.push("No matching threads.");
    return `${lines.join("\n")}\n`;
  }

  for (const thread of list.threads) {
    lines.push(
      `${thread.title || "(untitled)"}`,
      `  ID: ${thread.id}`,
      `  Project: ${thread.project?.title || "-"}`,
      `  Updated: ${thread.updatedAt || "-"}`,
      `  Created: ${thread.createdAt || "-"}`,
      "",
    );
  }

  return `${lines.join("\n")}\n`;
}

export function formatDoctorJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function createRecord(type, threadId, data) {
  return {
    schemaVersion: JSONL_SCHEMA_VERSION,
    recordType: type,
    threadId,
    data,
  };
}

export function jsonlRecordsForThread(thread) {
  const threadId = thread.thread.id;
  const header = {
    ...createRecord("thread", threadId, thread.thread),
    provider: thread.provider,
    warnings: thread.warnings,
  };

  return [
    header,
    ...chronologicalThreadEntries(thread)
      .map((entry) => createRecord(entry.type, threadId, entry.record)),
  ];
}

export function formatThreadJsonl(thread) {
  return `${jsonlRecordsForThread(thread).map((record) => JSON.stringify(record)).join("\n")}\n`;
}

export function formatListJsonl(list) {
  const header = createRecord("list", null, {
    filters: list.filters,
    ordering: list.ordering,
    limit: list.limit,
    offset: list.offset,
    count: list.count,
    hasMore: list.hasMore,
  });
  const records = [
    header,
    ...list.threads.map((summary) => createRecord("thread", summary.id, summary)),
  ];

  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

export function formatParticipantsJson(view) {
  return `${JSON.stringify(view, null, 2)}\n`;
}

export function formatParticipantsJsonl(view) {
  const header = createRecord("participants", view.threadId, {
    ordering: view.ordering,
    selection: view.selection,
    counts: view.counts,
    hierarchyAvailable: view.hierarchyAvailable,
    warnings: view.warnings,
  });
  const records = [
    header,
    ...view.participants.map((participant) => (
      createRecord("participant", view.threadId, participant)
    )),
  ];

  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function formatParticipantLines(participant, depth) {
  const indent = "  ".repeat(depth);
  const prefix = `${indent}    `;
  const lines = [`${indent}- ${participant.title || "(untitled task)"}`];
  addField(lines, `${prefix}Task ID`, participant.taskId);
  addField(lines, `${prefix}Role`, participant.role);
  addField(lines, `${prefix}Model`, participant.model);
  addCompactLine(lines, prefix, [
    ["Kind", participant.agentKind],
    ["Type", participant.taskType],
    ["Effort", participant.effort],
  ]);
  lines.push(`${prefix}State: ${participant.state}`);
  addField(lines, `${prefix}Status`, participant.status);
  // A projected summary is frequently the title verbatim; printing it twice is noise.
  const summary = summaryPreview(participant.summary) ?? summaryPreview(participant.detail);
  if (summary !== null && summary !== summaryPreview(participant.title)) {
    lines.push(`${prefix}Summary: ${summary}`);
  }
  addCompactLine(lines, prefix, [["Error", participant.error]]);
  addField(lines, `${prefix}Turn`, participant.turnId);
  if (Array.isArray(participant.turnIds) && participant.turnIds.length > 1) {
    lines.push(`${prefix}Turns: ${participant.turnIds.join(", ")}`);
  }
  addCompactLine(lines, prefix, [
    ["Seen", participant.firstSeenAt && participant.lastSeenAt && participant.firstSeenAt !== participant.lastSeenAt
      ? `${participant.firstSeenAt} -> ${participant.lastSeenAt}`
      : (participant.firstSeenAt ?? participant.lastSeenAt)],
  ]);
  const usage = participant.usage || {};
  const usageParts = [];
  if (usage.toolUses !== null && usage.toolUses !== undefined) {
    usageParts.push(`tool uses: ${usage.toolUses}`);
  }
  if (usage.totalTokens !== null && usage.totalTokens !== undefined) {
    usageParts.push(`tokens: ${usage.totalTokens}`);
  }
  const duration = formatDurationMs(usage.durationMs);
  if (duration !== null) {
    usageParts.push(`duration: ${duration}`);
  }
  const usageSuffix = usageParts.length > 0 ? ` (${usageParts.join(", ")})` : "";
  lines.push(`${prefix}Activities: ${participant.activityCount}${usageSuffix}`);
  addCompactLine(lines, prefix, [["Last tool", participant.lastToolName]]);
  addCompactLine(lines, prefix, [
    ["Output", participant.outputFile],
    ["Backgrounded", participant.isBackgrounded === null || participant.isBackgrounded === undefined
      ? null
      : (participant.isBackgrounded ? "yes" : "no")],
  ]);
  if (participant.path) {
    addField(lines, `${prefix}Path`, participant.path);
  }
  return lines;
}

function collectParticipantLines(participants, depth, lines) {
  for (const participant of participants) {
    lines.push(...formatParticipantLines(participant, depth));
    if (Array.isArray(participant.children) && participant.children.length > 0) {
      collectParticipantLines(participant.children, depth + 1, lines);
    }
  }
}

export function formatParticipantsHuman(view) {
  const lines = ["Participants", "============", ""];
  addField(lines, "Thread ID", view.threadId);
  lines.push(`Order: ${view.ordering.sortBy} ${view.ordering.direction}`);

  if (view.selection) {
    lines.push("", "Selection", "---------");
    addField(lines, "Kind", view.selection.kind);
    addField(lines, "Turn ID", view.selection.turnId);
    addField(lines, "Turn limit", view.selection.turnLimit);
    addField(lines, "Turn offset", view.selection.turnOffset);
  }

  lines.push("", "Counts", "------");
  addField(lines, "Total", view.counts.total);
  addField(lines, "Returned", view.counts.participants);
  addField(lines, "Roots", view.counts.roots);
  addField(lines, "With explicit parent", view.counts.withExplicitParent);
  addField(lines, "Unresolved parents", view.counts.unresolvedParents);

  lines.push("");
  lines.push(view.hierarchyAvailable
    ? "Hierarchy: explicit parent/child relationships were recorded for this thread."
    : "Hierarchy: no explicit parent/child relationships were recorded for this thread. "
      + "This is a flat list, not a tree; do not present it as one.");

  lines.push("", ...sectionHeading("Task participants"));
  if (view.participants.length === 0) {
    lines.push("No task participants.");
  } else {
    collectParticipantLines(view.participants, 0, lines);
  }

  if (view.warnings.length > 0) {
    lines.push("", "Warnings", "--------");
    for (const warning of view.warnings) {
      lines.push(`- ${warning.code}: ${warning.message}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function formatRawJsonl(records) {
  return records.length === 0
    ? ""
    : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

export { JSONL_SCHEMA_VERSION };
