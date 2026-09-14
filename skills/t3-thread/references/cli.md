# t3-thread CLI Reference

Assume the package is installed and the current task provides a sanitized thread ID.

## Configuration

```bash
t3-thread --home <t3-home> get <thread-id>
T3_HOME=<t3-home> t3-thread get <thread-id>
t3-thread --db <state-db> get <thread-id>
```

Resolution order is `--home`, `T3_HOME`, then the default T3 home. `--db` overrides the derived SQLite path and is useful for isolated fixtures.

## Exit codes

Every command shares this set; sections below note only the codes reachable from that command.

| Code | Meaning | Example |
| --- | --- | --- |
| 0 | Success | Normal output, or a valid empty result (e.g. an offset past the end) |
| 1 | Unexpected failure | Any error not classified below |
| 2 | Thread not found | `get`/`participants`/`tail` on an ID that matches nothing; `tail` when the thread disappears mid-run; `get`/`participants` with an exact `--turn` that matches nothing (see below) |
| 3 | Invalid arguments | Rejected or malformed options; validated before SQLite is opened; a failed `install` (conflicting or invalid target) |
| 4 | Database unavailable | Missing/unreadable database, missing projection schema, unreadable provider log, or a `tail` cycle that exhausts its retries |
| 5 | Raw JSONL partially unreadable | `get --raw-jsonl` hit at least one malformed provider line; valid records are still emitted on stdout, diagnostics on stderr |

`get` and `participants` can exit 2 while still emitting a complete envelope on stdout - the same emit-then-exit-non-zero pattern `doctor` uses for a failed diagnostic. This happens only for an exact `--turn` that matches no turn: the envelope carries a `TURN_NOT_FOUND` warning, `turns`/`participants` empty, and the process exits 2. A missing *thread* (`get <bad-id>`) is the older case: nothing on stdout, `t3-thread.error.v1` on stderr, exit 2. Do not treat every exit 2 as "nothing was printed" - check whether stdout has content first.

## List threads

```bash
t3-thread list
t3-thread list --project <text> --since <timestamp> --before <timestamp>
t3-thread list --limit <n> --offset <n> --reverse
t3-thread list --format human|json|jsonl
```

Options:

- `--project <text>` - match `projection_projects.title` case-insensitively; exact match on the trimmed title, not a substring search. Trimmed and rejected as invalid if empty.
- `--since <timestamp>` - inclusive lower bound on `updated_at`, ISO-8601.
- `--before <timestamp>` - exclusive upper bound on `updated_at`, ISO-8601. Adjacent `--since`/`--before` windows compose without overlap or double counting.
- `--limit <n>` - maximum threads returned; default 50; must be a positive integer (1 or greater) - `--limit 0` is rejected, not treated as "return nothing".
- `--offset <n>` - skip matching threads before applying `--limit`; default 0; non-negative integer (0 is valid).
- `--reverse` - newest-first instead of the default oldest-first.

Timezone rule for `--since`/`--before`: a date-time with no UTC offset is interpreted as **UTC**, not the host's local zone - matching the date-only form (already UTC) and matching UTC storage. `--since 2026-08-10T09:00` and `--since 2026-08-10T09:00Z` are identical. The space-separated form `--since "2026-08-10 09:00"` is treated the same way. `Z` and explicit `+HH:MM`/`-HH:MM` offsets are parsed as given, unchanged.

Invalid timestamps, a zero or negative limit, a negative offset, or an empty project filter produce the existing machine-readable `t3-thread.error.v1` error before SQLite is opened. A zero limit fails with `"limit must be a positive integer."`; a negative numeric value on any option fails with `"<option> does not accept a negative value."` (e.g. `--offset -1` -> `"--offset does not accept a negative value."`) rather than the older, misleading `"Missing value for <option>."`, which is now reserved for an actually-absent value.

Ordering: sorted by `updated_at`, then by `thread_id` as a tie-breaker, in the same direction as `--reverse`. Threads with a null `updated_at` sort last in both directions and are excluded entirely when `--since` or `--before` is used, because a null timestamp cannot satisfy a bound. Deleted threads (`deleted_at IS NOT NULL`) are always excluded.

Output: `--format json` and `--format jsonl` emit the `t3-thread.list.v1` envelope - `schemaVersion`, `toolVersion`, `filters` (`project`, `since`, `before`), `ordering` (`sortBy: "updatedAt"`, `direction`), `limit`, `offset`, `count`, `hasMore`, and `threads` (metadata-only summaries: `id`, `projectId`, `title`, `project`, `branch`, `worktreePath`, `createdAt`, `updatedAt`, `latestUserMessageAt`, `latestTurnId`). Listing output never contains message or activity text. `hasMore` indicates whether another page is available past `offset + limit`; page forward by increasing `--offset`.

`list --format json` (truncated to one thread; a real page returns up to `limit`):

```json
{
  "schemaVersion": "t3-thread.list.v1",
  "toolVersion": "0.2.1",
  "filters": { "project": null, "since": null, "before": null },
  "ordering": { "sortBy": "updatedAt", "direction": "asc" },
  "limit": 50,
  "offset": 0,
  "count": 7,
  "hasMore": false,
  "threads": [
    {
      "id": "THREAD_ID",
      "projectId": "project-1",
      "title": "Example thread title",
      "project": { "title": "Example project", "workspaceRoot": "/path/to/workspace" },
      "branch": "main",
      "worktreePath": "/path/to/worktree",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:02:00.000Z",
      "latestUserMessageAt": "2026-01-01T00:01:00.000Z",
      "latestTurnId": "turn-2"
    }
    // ...remaining threads, same shape
  ]
}
```

## Retrieve a thread

```bash
t3-thread get <thread-id>
t3-thread get <thread-id> --format json
t3-thread get <thread-id> --format jsonl
t3-thread get <thread-id> --raw-jsonl
t3-thread get <thread-id> --last-turn
t3-thread get <thread-id> --turn <turn-id>
t3-thread get <thread-id> --turn-limit <n> --turn-offset <n>
```

The default format shows thread metadata, provider metadata, turns, messages, activities, and warnings. JSON emits the complete `t3-thread.thread.v1` object. Normalized JSONL emits `thread`, `turn`, `message`, and `activity` records using `t3-thread.jsonl-record.v1`, in chronological order after the thread header - this is the default and only order for `get --format jsonl`; do not re-sort records.

`--raw-jsonl` emits parsed provider records one per line. A malformed provider line is reported on stderr and does not discard valid records; if any line was malformed the command still emits every valid record but exits 5 (`RAW_JSONL_PARTIALLY_UNREADABLE`), not 0.

### Bounded retrieval

- `--last-turn` - the newest turn and its associated records; shorthand for a one-turn newest-side window.
- `--turn <turn-id>` - one exact turn and its associated records.
- `--turn-limit <n>` - a bounded window of turns counted from the newest side; must be a positive integer (1 or greater) - `--turn-limit 0` is rejected; defaults to 1 when only `--turn-offset` is given.
- `--turn-offset <n>` - skip turns from the newest side before applying `--turn-limit`; non-negative integer; default 0.

Mutually exclusive combinations, rejected with the machine-readable invalid-arguments error:

- `--turn` cannot be combined with `--last-turn`, `--turn-limit`, or `--turn-offset`.
- `--last-turn` cannot be combined with `--turn-limit` or `--turn-offset`.

Selection: turns are selected from the newest side, then always emitted in chronological order. For each selected turn, the window includes the turn row, activities whose `turn_id` matches, and messages reached through `pending_message_id`, `assistant_message_id`, or a matching `turn_id`. Projected user prompts are stored with a null `turn_id`, so they are only reachable through `pending_message_id` - this is why `--last-turn` still includes the user prompt that started the turn. Records reached through more than one association path are deduplicated by ID. Plain `get <thread-id>` with none of these options is unchanged and returns the full history.

**Empty selection: two different meanings.** These look the same at first glance (empty `turns`) but are not the same condition, and the distinction is deliberate:

| Selection | Empty result means | Warnings | Exit code |
| --- | --- | --- | --- |
| `--turn <turn-id>` (exact) matches no turn | The turn ID does not exist in this thread - likely a stale or wrong ID | `TURN_NOT_FOUND` added to `warnings`, with `details.turnId` | 2 |
| `--turn-limit`/`--turn-offset`/`--last-turn` (a turn *window*) whose page lands past the end | A valid empty page, exactly like a `list` offset past the end | none | 0 |

`TURN_NOT_FOUND` fires for both `get` and `participants`. In both cases the full envelope is still emitted on stdout - `turns: []` (or `participants: []`), `selection.selectedTurnIds: []` - so a consumer must check `warnings`, not just the exit code, to know which case it is. Do not treat an exit-2, envelope-bearing response the same as the older missing-thread exit 2, which prints nothing on stdout.

Bounded output carries a `selection` object on the normalized thread: `kind` (`"turn"` or `"turn-window"`), `turnId`, `turnLimit`, `turnOffset`, `totalTurns`, `selectedTurnIds`. Full retrieval omits `selection` entirely - its presence is the machine-readable signal that output is partial. Human output for a bounded read adds a `Selection` block with `Partial history: yes` and renames the sections `Turns (partial)`, `Messages (partial)`, `Activities (partial)`.

`get --last-turn --format json` (messages/activities elided - see [Live state](#live-state) below for the full `liveState` block):

```json
{
  "schemaVersion": "t3-thread.thread.v1",
  "toolVersion": "0.2.1",
  "thread": { "id": "THREAD_ID", "title": "Example thread title", "...": "..." },
  "turns": [
    { "turnId": "turn-2", "state": "completed", "requestedAt": "2026-01-01T00:01:00.000Z", "...": "..." }
  ],
  "messages": [ /* elided */ ],
  "activities": [ /* elided */ ],
  "provider": { "providerName": "ExampleProvider", "status": "ready", "...": "..." },
  "liveState": { "status": "idle", "complete": true, "reasons": [], "...": "..." },
  "warnings": [],
  "selection": {
    "kind": "turn",
    "turnId": null,
    "turnLimit": 1,
    "turnOffset": 0,
    "totalTurns": 2,
    "selectedTurnIds": ["turn-2"]
  }
}
```

`get --turn does-not-exist-id --format json` (TURN_NOT_FOUND; exit 2, full envelope still printed):

```json
{
  "schemaVersion": "t3-thread.thread.v1",
  "toolVersion": "0.2.1",
  "thread": { "id": "THREAD_ID", "...": "..." },
  "turns": [],
  "messages": [],
  "activities": [],
  "provider": { "...": "..." },
  "liveState": { "...": "..." },
  "warnings": [
    {
      "code": "TURN_NOT_FOUND",
      "message": "No turn matched the requested turn ID.",
      "details": { "turnId": "does-not-exist-id" }
    }
  ],
  "selection": {
    "kind": "turn",
    "turnId": "does-not-exist-id",
    "turnLimit": null,
    "turnOffset": null,
    "totalTurns": 3,
    "selectedTurnIds": []
  }
}
```

### Live state

`liveState` is always present on `getThread()` output, unlike `selection`, which appears only for bounded reads:

- `status` - `"active"`, `"idle"`, or `"unknown"`; `"unknown"` means the projection gave no usable signal, not a default for a settled thread.
- `complete` - `false` while the projection shows the thread changing; `true` when it shows no in-flight signal. `true` is not proof that no agent is working: the upstream projection can mark a turn `completed` while an agent is still mid-turn, and this field faithfully reports the projected signal rather than inferring activity from timestamp recency. Describes the thread, not the retrieval window: a bounded `--last-turn` read reports the same `liveState` as a full read of the same thread at the same moment.
- `observedAt` - the tool's own read timestamp, ISO-8601 UTC.
- `providerStatus` - the thread's provider session status, or `null`.
- `latestTurnId` - the latest turn's identifier, or `null`.
- `latestTurnState` - the latest turn's state, or `null`.
- `streamingMessageCount` - count of messages currently marked streaming.
- `reasons` - sorted, deduplicated codes from the closed set `"turn-not-terminal"`, `"streaming-message"`, `"provider-active"`, explaining why `complete` is `false`; empty when `complete` is `true`.

`liveState` is derived from projected signals only - the latest turn's state, streaming message rows, and the provider session status - never from timestamp recency.

## Follow a live thread

```bash
t3-thread tail <thread-id>
t3-thread tail <thread-id> --once --format jsonl
t3-thread tail <thread-id> --interval <ms> --format jsonl
t3-thread tail <thread-id> --max-cycles <n> --timeout <ms> --turn-limit <n> --format jsonl
```

`tail` is read-only and polls the SQLite projection. It never opens the provider JSONL log. Each poll cycle opens a fresh read-only connection, reads inside a deferred transaction, rolls back, and closes - the same pattern as `get` - so a long-lived snapshot never hides another process's WAL commits.

Options:

- `--once` - poll once, emit the result, and exit. Mutually exclusive with `--interval`, `--max-cycles`, and `--timeout`.
- `--interval <ms>` - poll interval in milliseconds; default 1000; validated as an integer from 100 to 60000 inclusive, rejected outside that range before SQLite is opened.
- `--max-cycles <n>` - stop after `n` poll cycles. Usable together with `--timeout`; whichever fires first stops the tail.
- `--timeout <ms>` - stop after a wall-clock duration in milliseconds. Usable together with `--max-cycles`.
- `--turn-limit <n>` - bound each poll cycle to the newest `n` turns; reuses the same `normalizePositiveCount`-validated window machinery as `get --turn-limit` - must be a positive integer, `0` is rejected.
- `--format jsonl|json` - `jsonl` is the default, one record per line. `json` buffers the whole run into a single JSON array and is only accepted with a bounded tail (`--once`, `--max-cycles`, or `--timeout`); an unbounded tail with `--format json` is rejected because it would never finish.

With none of `--once`, `--max-cycles`, or `--timeout` given, `tail` follows indefinitely until interrupted - the only unbounded loop in the package. `tail` rejects `--title`, `--raw-jsonl`, and every `list`-only filter option, following the same per-command rejection rules as other commands.

`tail <thread-id> --once --format jsonl` (three lines of a longer stream - an `upsert`, another `upsert` with a different `recordType`, then the terminating `end` record):

```jsonl
{"schemaVersion":"t3-thread.tail-record.v1","op":"upsert","recordType":"turn","threadId":"THREAD_ID","observedAt":"2026-08-14T15:01:22.958Z","cycle":1,"data":{"turnId":"turn-2","state":"completed","...":"..."}}
{"schemaVersion":"t3-thread.tail-record.v1","op":"upsert","recordType":"message","threadId":"THREAD_ID","observedAt":"2026-08-14T15:01:22.958Z","cycle":1,"data":{"messageId":"message-2","role":"assistant","text":"Example answer","...":"..."}}
{"schemaVersion":"t3-thread.tail-record.v1","op":"end","recordType":"end","threadId":"THREAD_ID","observedAt":"2026-08-14T15:01:22.958Z","cycle":1,"data":{"reason":"once","cycles":1}}
```

### Tail record contract

Each emitted record is `t3-thread.tail-record.v1`:

```text
schemaVersion   "t3-thread.tail-record.v1"
op              "upsert", "live-state", or "end"
recordType      "thread", "turn", "message", "activity", "live-state", or "end"
threadId        the tailed thread's ID (nullable)
observedAt      the tool's own read timestamp for the cycle, ISO-8601 UTC
cycle           1-based poll cycle counter (0 only on an end record emitted before any cycle ran)
data            the record payload
```

`upsert` is replace-by-identifier, not append: a record seen for the first time and a record whose content changed both arrive as `upsert`. Consumers key on the record's stable identifier (turn, message, or activity ID) and replace. Cycle 1 emits the full baseline - a `thread` record, then every turn, message, and activity record, all `upsert` - and later cycles emit `upsert` only for records that are new or changed. Records within a cycle are in the same chronological order as normalized JSONL; do not re-sort them. A `live-state` record is emitted in cycle 1 and thereafter only when `liveState` changes. Exactly one `end` record is emitted when the tail stops, with `data.reason` one of:

- `"once"` - `--once` completed its single poll.
- `"max-cycles"` - `--max-cycles` was reached.
- `"timeout"` - `--timeout` elapsed.
- `"interrupt"` - SIGINT (or an aborted `AbortSignal` in the Node API) stopped the tail.
- `"thread-not-found"` - the thread disappeared or became unreadable mid-tail.

Deletions are out of scope: a record that disappears from the projection is not reported.

### Interruption, retries, and exit codes

- **SIGINT** stops polling, emits the `end` record with reason `"interrupt"`, flushes stdout, and exits 0.
- **A closed stdout**, for example under `head`, is handled quietly - no unhandled `EPIPE` error.
- **A busy or locked database** during a cycle does not kill the tail; it is retried on the next cycle, up to three consecutive failures, with a machine-readable diagnostic written to stderr each time. The fourth consecutive failure raises the existing `DatabaseUnavailableError` and exits 4.
- **A thread that disappears mid-tail** emits the `end` record with reason `"thread-not-found"` and exits 2, matching `ThreadNotFoundError`.
- **A missing thread at startup** behaves exactly like `get`: `ThreadNotFoundError`, exit 2, nothing on stdout.

These are the same exit codes used elsewhere (0, 2, 4); see [Exit codes](#exit-codes).

## Thread participants

```bash
t3-thread participants <thread-id>
t3-thread participants <thread-id> --format json
t3-thread participants <thread-id> --tree --format json
t3-thread participants <thread-id> --turn <turn-id> --format jsonl
```

A participant is one `taskId` within one thread, folded from that thread's explicit `task.started`, `task.progress`, `task.completed`, and `task.updated` activities, in the same chronological activity order `get` uses. The fold is last-non-null-wins per scalar field: a later activity that omits a field does not erase a value an earlier activity set.

Options:

- `--tree` - emit a nested tree instead of a flat array. Supported with `--format json` and `--format human`; rejected with `--format jsonl`, because JSONL is a flat one-record-per-line contract and a nested tree cannot be expressed in it without inventing a second envelope. `--tree` on a thread with no explicit parentage returns every participant as a root - that is correct output, not an error.
- `--last-turn` - only participants whose activities touch the newest turn; shorthand for a one-turn newest-side window (`selection.kind: "turn-window"`, `turnLimit: 1`, `turnOffset: 0`), the same resolution `get --last-turn` uses. Shares `get`'s mutual-exclusivity rule: cannot be combined with `--turn`, `--turn-limit`, or `--turn-offset`.
- `--turn <turn-id>` - only participants whose activities touch that turn. An exact `--turn` that matches no turn is the same `TURN_NOT_FOUND` condition documented under `get`'s [Bounded retrieval](#bounded-retrieval): the envelope still emits with `participants: []`, a `TURN_NOT_FOUND` warning, and exit 2.
- `--turn-limit <n>` - only participants touching the newest `n` turns; must be a positive integer (1 or greater) - `0` is rejected.
- `--turn-offset <n>` - skip turns from the newest side before applying `--turn-limit`. A turn-window page past the end (unlike an exact `--turn` miss) is a silent, valid empty page - no warning, exit 0.
- `--limit <n>` - maximum participants returned; **no default**, so the full participant list is returned unless a smaller page is explicitly requested; must be a positive integer when given - `0` is rejected.
- `--offset <n>` - skip matching participants before applying `--limit`; default 0.
- `--reverse` - newest-first instead of the default oldest-first.
- `--format human|json|jsonl`.

`--last-turn`, `--turn`, `--turn-limit`, and `--turn-offset` reuse the same `normalizeTurnSelection` validation as `get`, and `--limit` reuses `normalizePositiveCount` (`--offset` still uses `normalizeCount`, non-negative); all validation runs before SQLite is opened. `participants` rejects `--title`, `--raw-jsonl`, `--once`, `--interval`, `--max-cycles`, `--timeout`, and the `list`-only filters `--project`, `--since`, `--before`, following the same per-command rejection rules as other commands.

A `task.*` activity recorded with a null `turn_id` can never appear in any turn-bounded read (`--turn`, `--turn-limit`, `--turn-offset`, `--last-turn`): the underlying query matches selected turns with `turn_id IN (...)`, and SQL `NULL` never satisfies an `IN` list. This is deliberate and matches how `get` bounds its own turn windows on `turn_id`. It is a real, observed condition, not an edge case: roughly 98 of 6,338 observed `task.*` rows carry a null `turn_id`. A participant missing from a bounded view is not necessarily missing from the thread - re-run without turn selection to check the whole thread before concluding a participant is absent.

Ordering: sorted by `firstSeenAt`, then by `taskId` as a tie-breaker, in the same direction as `--reverse`. A participant with a null `firstSeenAt` sorts last in both directions, the same null-timestamp rule `list` and `find` use. Sibling labels inside `path` are always assigned in ascending order, so `--reverse` changes the display order without renumbering any path.

### Participant fields

Every participant always carries the same field set; absent projection data is `null`, never a missing key:

`taskId`, `parentTaskId`, `path`, `depth`, `title`, `role`, `model`, `agentKind`, `taskType`, `effort`, `status`, `state`, `summary`, `detail`, `error`, `toolUseId`, `lastToolName`, `workflowName`, `outputFile`, `isBackgrounded`, `turnId`, `turnIds`, `firstSeenAt`, `lastSeenAt`, `activityCount`, `usage`.

Fields worth calling out individually:

- **`turnId`** - the **first non-null** `turn_id` among the participant's contributing activities, not the turn of the literal earliest activity. A task whose earliest activity carries a null `turn_id` still reports the real turn it was first seen working in, rather than `turnId: null`.
- **`turnIds`** - every distinct non-null `turn_id` the participant touched, sorted.
- **`usage`** - `{ totalTokens, toolUses, durationMs }`, normalized from whichever of `typedUsage` (camelCase) or the snake_case `usage` payload is present, preferring `typedUsage`; unknown values stay `null`, not `0`.
- **`adapterSpecific`** - present only when non-empty. Holds everything the projection carries that is not modeled above (`phases`, `runHandles`, `timelineBypass`, `usageSnapshot`, `attempt`, `agentIndex`, `phaseIndex`, `phaseTitle`, and similar), plus one nuance for the modeled scalar fields (`title`, `role`, `model`, `agentKind`, `taskType`, `effort`, `status`, `summary`, `detail`, `error`, `toolUseId`, `lastToolName`, `workflowName`, `outputFile`, `isBackgrounded`): a value of the wrong type (e.g. `model` arriving as a number) is preserved in `adapterSpecific` **only if that field never resolved to a usable value from any activity in the fold**. If an earlier activity already produced a usable value for that field, a later wrong-typed value is dropped entirely - it appears neither at top level nor in `adapterSpecific`. This keeps the same key from ever appearing in both places, but it means a wrong-typed value is not always recoverable from the output.

`state` is derived from `status`, not the same field:

| `status` | `state` | Meaning |
| --- | --- | --- |
| `null` (never recorded) | `"unknown"` | No status was ever projected |
| `completed` / `failed` / `stopped` / `cancelled` | `"finished"` | Terminal |
| any other non-null value, including unrecognised strings | `"running"` | Non-terminal - an unrecognised status is deliberately reported as running rather than finished, since claiming a still-running agent finished is the more damaging error |

### Hierarchy

`parentTaskId` is populated **only** from an explicit `parentAgentId` recorded on a contributing activity, and only when it resolves to another participant's `taskId` in the same thread. Hierarchy is **never** inferred from timestamps, activity order, `sequence`, tool-use IDs, or identifier shape - two tasks that merely ran next to each other are two roots.

`hierarchyAvailable` is the machine-readable signal to check before presenting a tree: `true` only when at least one participant has a resolved `parentTaskId`. It is `false` for the great majority of real threads, and that is the correct, expected answer, not a failure.

`path` (for example `main.subagent1.subagent1a`) is present only when a participant's entire ancestry to a root is explicitly known and resolvable; it is `null` when any ancestor is unresolved, cyclic, or out of the turn selection (see `PARENT_OUT_OF_SELECTION` below). The synthetic first segment is always `main`. Sibling segments are numbered by the deterministic participant ordering (`firstSeenAt`, then `taskId` as a tie-breaker) - that ordering only assigns a label to an already-known child; it is never used to infer the parent/child edge itself, which always comes from `parentAgentId`. `depth` is `0` for a root and `parent.depth + 1` otherwise, computed only through resolved edges.

A task whose `parentAgentId` equals its own `taskId` resolves - the identifier does name a known participant - so it is reported as `PARENT_CYCLE` (a one-node cycle), not `UNRESOLVED_PARENT`. A task that is merely downstream of a cycle, not on the cycle itself, keeps its own explicit `parentTaskId` and loses only its `path`, since ancestry through a broken link can no longer be confirmed; only tasks actually on the cycle are demoted to roots and named in `PARENT_CYCLE`.

#### Warning codes

| Code | Fires when | `parentTaskId` | `path` | Reported as | Counted in |
| --- | --- | --- | --- | --- | --- |
| `UNRESOLVED_PARENT` | Recorded `parentAgentId` resolves to no task anywhere in the thread - checked against the whole thread, not just the selected turns | `null` | `null` | Root | `counts.unresolvedParents`, `counts.roots` |
| `PARENT_OUT_OF_SELECTION` | Under a turn selection (`--turn`, `--turn-limit`, `--turn-offset`, `--last-turn`) only: `parentAgentId` names a real task elsewhere in the thread, but that task's own activities fall outside the selected turns | populated | `null` | Top level | `counts.withExplicitParent` - **not** `counts.unresolvedParents` |
| `PARENT_CYCLE` | Recorded parentage forms a cycle (A->B->A, or a task naming itself) | `null` (cleared) | `null` | Root | `counts.roots` - not `counts.withExplicitParent` |
| `PARENT_OUT_OF_PAGE` | `--tree` with `--limit`/`--offset`: a parent that resolved *within the selection* falls outside the returned page | populated | unaffected (keeps its resolved value; only its position in the returned tree changes) | Top level, in the tree only | unaffected - counts are computed before paging |

`details.taskIds` (sorted) lists the affected **child** task IDs for `PARENT_OUT_OF_SELECTION`, `PARENT_CYCLE`, and `PARENT_OUT_OF_PAGE`. `UNRESOLVED_PARENT` is emitted once per occurrence with `details: { taskId, parentAgentId }` instead of an aggregated list. A child reported under `PARENT_OUT_OF_SELECTION` is never also named by `PARENT_OUT_OF_PAGE` for the same missing parent - the two codes split the same "parent not in view" condition by cause (turn window vs. page).

The table above covers only hierarchy warnings, all scoped to individual participants. One more warning code can appear in `participants`' `warnings` array and is not about hierarchy at all: `TURN_NOT_FOUND` - an exact `--turn` that matches no turn in the thread, `details: { turnId }`, `participants: []`, exit 2. See the empty-selection table under `get`'s [Bounded retrieval](#bounded-retrieval); `participants` follows the identical rule.

### Envelope and exit codes

`--format json` and `--format jsonl` emit `t3-thread.participants.v1`: `schemaVersion`, `toolVersion`, `threadId`, `ordering`, `selection` (`null` for a whole-thread read, otherwise the turn selection), `counts`, `hierarchyAvailable`, `participants`, and `warnings`. `--format jsonl` emits `t3-thread.jsonl-record.v1` records: a `participants` header record carrying the envelope metadata, followed by one `participant` record per participant.

`counts` has two different scopes; mixing them up is the easiest mistake a consumer can make:

| Field | What it counts | Changes with `--limit`/`--offset`? | Changes with a turn selection? |
| --- | --- | --- | --- |
| `counts.total` | Participants matching before `--limit`/`--offset` - compare to `counts.participants` to detect truncation | No (this *is* the pre-paging count) | Yes - narrowed to the selected turns' activities |
| `counts.participants` | Participants actually returned in this page | Yes - this is the page size | Yes (inherits the narrowing above) |
| `counts.roots` | Participants with `parentTaskId === null`, before paging | No | Yes |
| `counts.withExplicitParent` | Participants with `parentTaskId !== null`, before paging - includes `PARENT_OUT_OF_SELECTION` children | No | Yes |
| `counts.unresolvedParents` | Count of `UNRESOLVED_PARENT` warnings only - excludes `PARENT_OUT_OF_SELECTION` | No | Yes |
| `hierarchyAvailable` | `true` iff `counts.withExplicitParent > 0`, before paging | No | Yes |

With no turn selection, the "before paging" columns describe the whole thread. Under `--turn`/`--turn-limit`/`--turn-offset`/`--last-turn`, they describe only the selected turns - so `hierarchyAvailable: false` on a bounded read is not evidence the thread has no hierarchy in some other turn, and a `PARENT_OUT_OF_SELECTION` warning (not `UNRESOLVED_PARENT`) is the signal that the missing edge is a narrow window, not corrupt data.

Exit codes (see [Exit codes](#exit-codes)):

- A thread that exists but has no task activities returns a valid envelope with an empty `participants` array, `counts.participants: 0`, and `hierarchyAvailable: false` - exit 0, not an error.
- A missing thread is `ThreadNotFoundError`, exit 2, nothing on stdout, exactly as `get`.
- An exact `--turn` that matches no turn returns a valid envelope with `TURN_NOT_FOUND` in `warnings` and `participants: []` - exit 2, but with a full envelope on stdout, unlike the missing-thread case above.
- Rejected or invalid options return the existing machine-readable `t3-thread.error.v1` error, exit 3.

`participants --format json` (flat, no turn selection):

```json
{
  "schemaVersion": "t3-thread.participants.v1",
  "toolVersion": "0.2.1",
  "threadId": "THREAD_ID",
  "ordering": { "sortBy": "firstSeenAt", "direction": "asc" },
  "selection": null,
  "counts": { "total": 3, "participants": 3, "roots": 3, "withExplicitParent": 0, "unresolvedParents": 0 },
  "hierarchyAvailable": false,
  "participants": [
    {
      "taskId": "task-alpha",
      "parentTaskId": null,
      "path": "main.subagent1",
      "depth": 0,
      "title": "Example task",
      "role": "general-purpose",
      "status": "completed",
      "state": "finished",
      "turnId": "turn-1",
      "turnIds": ["turn-1"],
      "firstSeenAt": "2026-03-01T00:00:20.000Z",
      "lastSeenAt": "2026-03-01T00:00:40.000Z",
      "activityCount": 3,
      "usage": { "totalTokens": 1500, "toolUses": 5, "durationMs": 6000 }
      // ...remaining fields from "Participant fields" above, e.g. model, agentKind, error
    }
    // ...remaining participants, same shape
  ],
  "warnings": []
}
```

`participants --tree --format json` (nested; `path`/`depth` shown at each level, one `UNRESOLVED_PARENT` warning included to show its shape):

```json
{
  "schemaVersion": "t3-thread.participants.v1",
  "toolVersion": "0.2.1",
  "threadId": "THREAD_ID",
  "ordering": { "sortBy": "firstSeenAt", "direction": "asc" },
  "selection": null,
  "counts": { "total": 2, "participants": 2, "roots": 1, "withExplicitParent": 1, "unresolvedParents": 1 },
  "hierarchyAvailable": true,
  "participants": [
    {
      "taskId": "root-task",
      "parentTaskId": null,
      "path": "main.subagent1",
      "depth": 0,
      "title": "Root",
      "...": "...",
      "children": [
        {
          "taskId": "child-task",
          "parentTaskId": "root-task",
          "path": "main.subagent1.subagent1a",
          "depth": 1,
          "title": "Child",
          "...": "...",
          "children": []
        }
      ]
    }
  ],
  "warnings": [
    {
      "code": "UNRESOLVED_PARENT",
      "message": "A task recorded a parent that does not resolve to a known participant.",
      "details": { "taskId": "orphan-task", "parentAgentId": "missing-parent-task" }
    }
  ]
}
```

With a turn selection, a child can keep its real parent ID even when the parent's own
activities are outside the selected turns. It is then surfaced at the top level with a null
path and a `PARENT_OUT_OF_SELECTION` warning, for example:

```json
{
  "selection": { "kind": "turn", "turnId": "turn-2" },
  "participants": [
    {
      "taskId": "child-task",
      "parentTaskId": "root-task",
      "path": null,
      "depth": 0,
      "children": []
    }
  ],
  "warnings": [
    {
      "code": "PARENT_OUT_OF_SELECTION",
      "message": "A recorded parent's activities fall outside the selected turns, so the child is reported at the top level.",
      "details": { "taskIds": ["child-task"] }
    }
  ]
}
```

## Search and diagnose

```bash
t3-thread find --title "topic"
t3-thread find --title "topic" --format json
t3-thread find --title "topic" --reverse
t3-thread doctor
t3-thread doctor --format json
```

Title search is trimmed, case-insensitive, parameterized, excludes deleted threads, and does not search message content - use `find` when the task provides a title fragment, not an exact thread ID. `find` defaults to oldest-first chronological order and takes `--reverse` for newest-first, the same meaning `--reverse` has for `list`. `find` supports `--format human` and `--format json` only - no `--format jsonl`. `find` has no `--limit`/`--offset`; it always returns every match, and there is deliberately no `limit`/`offset`/`hasMore` in its output for that reason. Doctor reports the resolved home, database readability, schema health, counts, WAL presence, provider-log directory, runtime, and package version.

`find --format json` emits the `t3-thread.find.v1` envelope - `schemaVersion`, `toolVersion`, `filters.title`, `ordering` (`sortBy: "updatedAt"`, `direction`), `count`, and `threads`. Each entry in `threads` is the **same per-thread shape** `list` returns (`id`, `projectId`, `title`, `project`, `branch`, `worktreePath`, `createdAt`, `updatedAt`, `latestUserMessageAt`, `latestTurnId`) - metadata only, never message or activity text.

```json
{
  "schemaVersion": "t3-thread.find.v1",
  "toolVersion": "0.2.1",
  "filters": { "title": "topic" },
  "ordering": { "sortBy": "updatedAt", "direction": "asc" },
  "count": 2,
  "threads": [
    {
      "id": "THREAD_ID",
      "projectId": "project-1",
      "title": "Example thread about the topic",
      "project": { "title": "Example project", "workspaceRoot": "/path/to/workspace" },
      "branch": "main",
      "worktreePath": "/path/to/worktree",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:02:00.000Z",
      "latestUserMessageAt": "2026-01-01T00:01:00.000Z",
      "latestTurnId": "turn-2"
    }
    // ...remaining matches, same shape
  ]
}
```

**Breaking change from `0.1.0`:** `find --format json` published as a bare array of matches in `0.1.0`. It is now this envelope. A consumer parsing the old shape must migrate to reading `.threads` instead of iterating the top-level value directly.

An `error.v1` example (the shape every command's stderr error, and every non-zero-exit failure that doesn't emit a full envelope, uses):

```json
{
  "schemaVersion": "t3-thread.error.v1",
  "code": "INVALID_ARGUMENTS",
  "message": "limit must be a positive integer.",
  "details": { "field": "limit", "value": "0" }
}
```

`error.v1` carries `schemaVersion` only, not `toolVersion` - `tail-record.v1` and per-line `jsonl-record.v1` records are the same way. `toolVersion` is present on `thread.v1`, `list.v1`, `find.v1`, `participants.v1`, and the `doctor` report; see the "Schema and compatibility policy" section of the top-level `README.md` for the full breakdown.

## Schemas

```bash
t3-thread schema thread.v1
t3-thread schema error.v1
t3-thread schema jsonl-record.v1
t3-thread schema list.v1
t3-thread schema tail-record.v1
t3-thread schema participants.v1
t3-thread schema doctor.v1
t3-thread schema find.v1
```

Schema output is written to stdout and is suitable for redirecting into a fixture or validator.

## Install the bundled skill

The package includes a sanitized recovery skill bundle. Install it for one agent target:

```bash
t3-thread install --skills claude
t3-thread install --skills codex
```

Destinations are `~/.claude/skills/t3-thread` for Claude and `$CODEX_HOME/skills/t3-thread`, or `~/.codex/skills/t3-thread` when `CODEX_HOME` is unset. Alongside `SKILL.md` and `references/`, the installed directory carries `agents/openai.yaml` - a small Codex-style agent-interface metadata stub (display name, short description, default prompt) bundled with the skill; it is not a command reference and does not need to be read to use the CLI.

An existing destination is never silently removed. Choose one explicit replacement policy:

```bash
t3-thread install --skills claude --overwrite
t3-thread install --skills claude --backup
t3-thread install --skills codex --backup
```

`--overwrite` replaces the existing directory. `--backup` moves it to a timestamped sibling backup before installing. The installer copies only the package's allowlisted skill files and rejects a missing or malformed source bundle.

`install` fails with exit 3 (not 2 or 4) in two cases: the destination already exists and neither `--overwrite` nor `--backup` was given (`"The destination already exists; pass --overwrite or --backup to replace it."`), or the target itself is invalid - an unsupported `--skills` value, a symlinked skills directory, or a resolved path that escapes the selected skills directory. Both surface as a `t3-thread.error.v1` error on stderr, exit 3, same as any other rejected-arguments case.
