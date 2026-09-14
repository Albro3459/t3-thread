---
name: "t3-thread"
description: "Use when a T3 Code conversation thread must be recovered, listed, searched by title, tailed while active, or inspected for participants/hierarchy from the local read-only projection or provider JSONL."
---

# T3 Thread Skill

Use the `t3-thread` CLI to retrieve persisted T3 Code conversation threads without scanning arbitrary storage or changing T3 data. The SQLite projection is the primary source. Provider JSONL is an optional raw source for events not represented in the projection.

## Prerequisite check

```bash
command -v t3-thread >/dev/null 2>&1
```

If missing, install: `npm install -g @albro3459/t3-thread`. Run `t3-thread --help` for the full command reference.

## Recovery workflow

1. No exact thread ID? List or search instead of guessing. Decision rule: filtering/paginating by project or a time window is `list --format json` (`--project`, `--since`, `--before`, `--limit`, `--offset`, `--reverse`); a substring match against thread titles is `find --title "..." --format json`. `find` never searches message content and has no `--limit`/`--offset` - it always returns every title match. Pick one candidate; do not open every result.
2. Confirm the candidate before full retrieval: `t3-thread get <thread-id> --last-turn --format json`. Only run a full `get` once confirmed.
3. Any output carrying a `selection` object (from `--last-turn`, `--turn`, `--turn-limit`, or `--turn-offset`) is partial history - say so explicitly, never imply it is the whole conversation.
4. Use `--format json` for the complete `thread.v1` object, `--format jsonl` for one normalized record per line. JSONL records after the header are already chronological - do not re-sort.
5. Use `--raw-jsonl` only when projection data is insufficient. Preserve and report warnings and diagnostics rather than hiding them.
6. Run `t3-thread doctor --format json` when the database or expected schema is unavailable. Never do broad storage discovery; never print sensitive transcript content beyond what the task requires.
7. An exact `--turn <turn-id>` that matches nothing is not the same as a turn-window page past the end. The former emits a `TURN_NOT_FOUND` warning (`get` or `participants`) and exits 2 while still printing the full envelope - check `warnings`, don't just retry. The latter (`--turn-limit`/`--turn-offset`/`--last-turn` landing past the end) is a silent, valid empty page: no warning, exit 0. See `references/cli.md` for the full table.

## Live state and following an active thread

Every `get` result carries `liveState`.

1. Read `liveState.complete` before summarizing. Both readings report projected signals, not ground truth: `false` means the projection shows an in-flight turn - say the thread is still active, never present that turn as finished. `true` means the projection shows no in-flight signal, not a guarantee that no agent is working, because the upstream projection can mark a turn `completed` while an agent is still mid-turn.
2. `get THREAD_ID --last-turn --format json` for a one-shot state check; `tail THREAD_ID --once --format jsonl` for a change-oriented check.
3. In automation, only run a bounded tail - `--once`, `--max-cycles`, or `--timeout`. An unbounded tail is only appropriate in an interactive session a human can interrupt.
4. Every `upsert` tail record is replace-by-identifier, not append. First-seen and changed records both arrive as `upsert` - key on the record's stable identifier and replace, never accumulate a log.
5. Records within a tail cycle are chronological, same ordering as `get --format jsonl`. Do not re-sort.
6. Report interruption and retry diagnostics honestly: a tail ending with `"interrupt"`, stopped by `--max-cycles`/`--timeout`, or that hit retried database errors is a partial view - never present it as a complete transcript.
7. Provider JSONL never determines live state. The SQLite projection is canonical for `liveState`, and `tail` never opens the provider log.

## Thread participants

1. `t3-thread participants THREAD_ID` answers "who worked on this thread" - never guess participants from message text or tool activity.
2. Check `hierarchyAvailable` before presenting any tree. `false` is the common case for real threads, not a failure - state it plainly.
3. Hierarchy comes only from an explicit, resolvable `parentAgentId`; it is never inferred from timestamps, order, or identifier shape. Never claim one agent invoked another unless `parentTaskId` is populated, and never present a flat list as a hierarchy.
4. Prefer `state` over raw `status` for a quick answer; report `"unknown"` honestly rather than guessing a task finished.
5. Warnings - report all of these rather than hiding them:
   - `UNRESOLVED_PARENT` - the recorded parent does not exist anywhere in the thread. Treat as genuinely unresolvable.
   - `PARENT_CYCLE` - parentage loops back on itself; affected tasks are reported as roots.
   - `PARENT_OUT_OF_PAGE` - `--tree` combined with `--limit`/`--offset` put a resolved parent outside the returned page; the child is surfaced at the top level, not dropped.
   - `PARENT_OUT_OF_SELECTION` - only under a turn selection (`--turn`, `--turn-limit`, `--turn-offset`, `--last-turn`). The child's recorded parent is a real task in the thread, but that parent's own activities fall outside the selected turns. The child keeps a populated `parentTaskId`, gets `path: null`, and is reported at the top level. This is not corrupt or incomplete data - say the parent is outside the selected turns and offer to re-run without turn selection.
   - `TURN_NOT_FOUND` - an exact `--turn` matched no turn in the thread; `participants: []`, exit 2, full envelope still printed. Not a hierarchy warning - distinguish it from `PARENT_OUT_OF_SELECTION`, which means the turn selection is valid but a parent's activities fall outside it.
   - `hierarchyAvailable: true` can legitimately accompany a visually flat or partial tree when `PARENT_OUT_OF_PAGE` or `PARENT_OUT_OF_SELECTION` is present - check the warnings, not the shape of the tree.
6. Bound the view (`--last-turn`, `--turn`, `--turn-limit`, `--limit`) on participant-heavy threads - real threads have had 261 distinct tasks. A `task.*` activity recorded with a null `turn_id` can never appear in a turn-bounded read; if an expected participant is missing from a bounded view, re-run without turn selection before concluding it is absent.
7. Combine with `liveState` on an active thread: a participant in `state: "running"` on a settled thread (`liveState.complete: true`) usually means the task ended without a terminal status being projected, not that it is still executing.

## Safe defaults

- Retrieval is read-only.
- Home resolution order: `--home`, then `T3_HOME`, then the default T3 home.
- No recursive discovery or broad filesystem search.
- Diagnostics go to stderr for commands whose primary output is data.
- Never print credentials, bearer tokens, private prompts, or unrelated files.
- If history is missing, malformed, or only partially available, preserve the CLI warning or error and say what was unavailable. Do not reconstruct a complete conversation from token deltas when a normalized SQLite projection is present.

## Examples

Find a thread:

```bash
t3-thread list --reverse --limit 20 --format json
t3-thread list --project "Example Project" --since 2026-08-10 --format json
t3-thread find --title "project topic" --format json
```

`list --format json` shape (envelope + one truncated thread; `find --format json` returns the identical per-thread shape under `.threads`, plus `filters`/`ordering`/`count` and no `limit`/`offset`/`hasMore`):

```json
{ "schemaVersion": "t3-thread.list.v1", "toolVersion": "0.2.1",
  "filters": { "project": null, "since": null, "before": null },
  "ordering": { "sortBy": "updatedAt", "direction": "asc" },
  "limit": 50, "offset": 0, "count": 7, "hasMore": false,
  "threads": [ { "id": "THREAD_ID", "title": "...", "project": { "title": "...", "workspaceRoot": "..." }, "...": "..." } ] }
```

Read a bounded window:

```bash
t3-thread get THREAD_ID --last-turn --format json
t3-thread get THREAD_ID --turn-limit 3 --turn-offset 2 --format jsonl
t3-thread get THREAD_ID --format json
t3-thread get THREAD_ID --format jsonl
t3-thread get THREAD_ID --raw-jsonl
```

A bounded `get` carries `selection`; an exact `--turn` that matches nothing adds `TURN_NOT_FOUND` to `warnings` and exits 2 with the envelope still printed - a turn-window page past the end is silent (exit 0, no warning). Full detail and examples: `references/cli.md`.

Follow an active thread:

```bash
t3-thread tail THREAD_ID --once --format jsonl
t3-thread tail THREAD_ID --interval 2000 --format jsonl
t3-thread tail THREAD_ID --max-cycles 5 --turn-limit 2 --format jsonl
t3-thread tail THREAD_ID --timeout 30000 --format jsonl
```

Each `tail` line is one `t3-thread.tail-record.v1` record, `op` one of `"upsert"`/`"live-state"`/`"end"`:

```jsonl
{"schemaVersion":"t3-thread.tail-record.v1","op":"upsert","recordType":"turn","threadId":"THREAD_ID","cycle":1,"data":{"...":"..."}}
{"schemaVersion":"t3-thread.tail-record.v1","op":"end","recordType":"end","threadId":"THREAD_ID","cycle":1,"data":{"reason":"once","cycles":1}}
```

Inspect participants:

```bash
t3-thread participants THREAD_ID --format json
t3-thread participants THREAD_ID --tree --format json
t3-thread participants THREAD_ID --turn TURN_ID --format jsonl
t3-thread participants THREAD_ID --limit 20 --offset 20 --reverse --format json
```

`participants --format json` shape:

```json
{ "schemaVersion": "t3-thread.participants.v1", "toolVersion": "0.2.1", "threadId": "THREAD_ID",
  "ordering": { "sortBy": "firstSeenAt", "direction": "asc" }, "selection": null,
  "counts": { "total": 3, "participants": 3, "roots": 3, "withExplicitParent": 0, "unresolvedParents": 0 },
  "hierarchyAvailable": false,
  "participants": [ { "taskId": "task-alpha", "parentTaskId": null, "path": "main.subagent1", "depth": 0, "state": "finished", "...": "..." } ],
  "warnings": [] }
```

Diagnose and install:

```bash
t3-thread doctor --format json
t3-thread schema thread.v1
t3-thread install --skills claude
t3-thread install --skills codex --backup
```

Every command's failure path uses `t3-thread.error.v1` on stderr (`schemaVersion`, `code`, `message`, `details` - no `toolVersion`):

```json
{ "schemaVersion": "t3-thread.error.v1", "code": "INVALID_ARGUMENTS", "message": "limit must be a positive integer.", "details": { "field": "limit", "value": "0" } }
```

## References

- CLI options and output contracts: `references/cli.md`
- Practical recovery and troubleshooting flows: `references/workflows.md`
