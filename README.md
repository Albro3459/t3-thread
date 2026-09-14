# t3-thread

`t3-thread` is a small, read-only Node.js package and CLI for retrieving persisted T3 Code conversation threads by exact thread ID. It reads the documented SQLite projection and, on request, the exact provider JSONL event file. It does not scan arbitrary storage, call a cloud service, resume sessions, or write to T3 data.

## Requirements

- Node.js 22.16 or newer
- A local T3 home with the documented projection, when retrieving real data

## Installation

Install the public package globally:

```bash
npm install -g @albro3459/t3-thread
```

Or run it without a global install:

```bash
npx @albro3459/t3-thread --help
```

The package exposes the `t3-thread` executable and a small ESM API. Verify the installed package version with:

```bash
t3-thread --version
```

```js
import { createT3ThreadClient } from "@albro3459/t3-thread";

const client = await createT3ThreadClient({ home: process.env.T3_HOME });
const thread = await client.getThread("THREAD_ID");
const recentTurn = await client.getThread("THREAD_ID", { lastTurn: true });
const found = await client.findThreads({ title: "topic" }); // { schemaVersion, filters, ordering, count, threads }
const page = await client.listThreads({ project: "Example Project", since: "2026-08-10", limit: 20 });

const tail = client.tailThread("THREAD_ID", { maxCycles: 5, turnLimit: 2 });
for await (const record of tail) { /* t3-thread.tail-record.v1 */ }

const participants = await client.listParticipants("THREAD_ID", { tree: true });
```

`tailThread` accepts an `AbortSignal` (`signal`) for cancellation, and injectable `now()`/`sleep()` functions so tests can drive the tail deterministically without depending on real elapsed time.

## Configuration

The normal SQLite path is resolved in this order:

1. `--home PATH`
2. `T3_HOME`
3. the default user T3 home

The derived database is `<home>/userdata/state.sqlite`. Use `--db PATH` for an isolated fixture or unusual installation. The exact provider file is `<home>/userdata/logs/provider/events.<thread-id>.log`.

## List threads

```bash
t3-thread list
t3-thread list --reverse --limit 20 --format json
t3-thread list --project "Example Project" --since 2026-08-10 --format json
```

Supported options:

```text
--project <text>       Match a project title, case-insensitively (exact match on the trimmed title, not a substring search)
--since <timestamp>    Inclusive lower bound on updated_at, ISO-8601
--before <timestamp>   Exclusive upper bound on updated_at, ISO-8601
--limit <n>            Maximum threads returned; default 50; must be a positive integer (0 is rejected)
--offset <n>           Skip matching threads before applying --limit
--reverse              Newest-first instead of the default oldest-first
--format human|json|jsonl
```

The default limit is 50, so a listing cannot be retrieved unbounded by accident; pass `--limit` to request a different page size. `--limit 0` is rejected with `"limit must be a positive integer."` rather than silently returning nothing. A negative value on any numeric option (`--limit -1`, `--offset -1`, and so on) is rejected with `"<option> does not accept a negative value."` Ordering is deterministic: threads are sorted by `updated_at`, then by `thread_id` as a tie-breaker in the same direction. Threads with a null `updated_at` sort last in both the default and `--reverse` order, and are excluded entirely when `--since` or `--before` is used, since a null timestamp cannot satisfy a bound. `--since` is inclusive and `--before` is exclusive, so adjacent time windows compose without overlapping or double counting. An ISO-8601 date-time given without a UTC offset - including the space-separated form, e.g. `2026-08-10 09:00` - is interpreted as UTC, matching the date-only form and UTC storage. Deleted threads are excluded. `--format json` and `--format jsonl` emit the `t3-thread.list.v1` envelope, which reports `filters`, `ordering`, `limit`, `offset`, `count`, and `hasMore` alongside the returned `threads`. Use `hasMore` with `--offset` to page through results. Listing output contains thread metadata only - it never includes message or activity text.

## Retrieve a thread

```bash
t3-thread get THREAD_ID
t3-thread get THREAD_ID --format json
t3-thread get THREAD_ID --format jsonl
t3-thread get THREAD_ID --raw-jsonl
t3-thread get THREAD_ID --last-turn --format json
t3-thread get THREAD_ID --turn-limit 3 --format jsonl
```

The default output is human-readable metadata, provider information, turns, messages, activities, and warnings. `--format json` emits the complete `t3-thread.thread.v1` object. `--format jsonl` emits stable normalized records with record types `thread`, `turn`, `message`, and `activity`, in chronological order after the thread header. `--raw-jsonl` emits parsed provider events and preserves their labels and timestamps. Malformed provider lines are reported as warnings without discarding valid records.

Bounded retrieval options limit `get` to a window of turns instead of the full history:

```text
--last-turn            The newest turn and its associated records (shorthand for a one-turn newest-side window)
--turn <turn-id>       One exact turn and its associated records
--turn-limit <n>       A bounded window of turns counted from the newest side (defaults to 1 when only --turn-offset is given; must be a positive integer, 0 is rejected)
--turn-offset <n>      Skip turns from the newest side before applying --turn-limit
```

`--turn` cannot be combined with `--last-turn`, `--turn-limit`, or `--turn-offset`; `--last-turn` cannot be combined with `--turn-limit` or `--turn-offset`. Turns are selected from the newest side but always emitted in chronological order. A window includes the turn row, the activities whose `turn_id` matches, and the messages reached through `pending_message_id`, `assistant_message_id`, or a matching `turn_id` - this includes projected user prompts, which are stored with a null `turn_id`, so `--last-turn` still includes the user prompt that started the turn. Plain `t3-thread get THREAD_ID` is unchanged and still returns the full history.

A turn-window page past the end (`--turn-limit`/`--turn-offset`/`--last-turn`) is a valid empty page - empty `turns`/`messages`/`activities`, no warning, exit 0 - the same as an empty `list` page. An exact `--turn <turn-id>` that matches nothing is different: it is reported, not silent. The envelope still comes back in full, but with a `TURN_NOT_FOUND` warning (`details.turnId`) in `warnings`, and the process exits 2. This applies to both `get` and `participants`. See `skills/t3-thread/references/cli.md` for the full table.

Bounded results are machine-detectable: the normalized thread gains a `selection` object (`kind`, `turnId`, `turnLimit`, `turnOffset`, `totalTurns`, `selectedTurnIds`). Full retrieval omits `selection` entirely, so existing consumers are unaffected. Human output for a bounded read shows a `Selection` block with `Partial history: yes` and labels the sections `Turns (partial)`, `Messages (partial)`, and `Activities (partial)`.

### Live state

Unlike `selection`, which appears only for bounded reads, `liveState` is always present on `getThread()` output - an agent never has to opt in to learn that a thread may still be changing. Fields:

```text
status                  "active", "idle", or "unknown"; "unknown" means the projection gave no usable signal, not that the thread is settled
complete                false while the thread still appears to be changing, true once it appears settled
observedAt              the tool's own read timestamp, ISO-8601 UTC
providerStatus          the thread's provider session status, or null
latestTurnId            the latest turn's identifier, or null
latestTurnState         the latest turn's state, or null
streamingMessageCount   count of messages currently marked streaming
reasons                 sorted array of codes explaining why complete is false
```

`reasons` is drawn from a closed set: `"turn-not-terminal"`, `"streaming-message"`, `"provider-active"`. It is empty exactly when `complete` is `true`. `liveState` describes the thread, not the retrieval window: a bounded `--last-turn` read reports the same `liveState` as a full read of the same thread at the same moment. It is derived from projected signals only - the latest turn's state, streaming message rows, and the provider session status - never from timestamp recency. A thread is not considered active merely because it was updated recently. The converse limit is worth stating plainly: `complete: true` means the projection shows no in-flight signal, not that no agent is working - an upstream projection can mark a turn `completed` while an agent is still mid-turn.

## Follow a live thread

```bash
t3-thread get THREAD_ID --format json
t3-thread tail THREAD_ID --once --format jsonl
t3-thread tail THREAD_ID --interval 2000 --format jsonl
t3-thread tail THREAD_ID --max-cycles 5 --turn-limit 2 --format jsonl
```

`tail` polls the SQLite projection read-only and reports what changed since the previous poll. It never opens the provider JSONL log; the projection is the only live source. Each poll cycle opens a fresh read-only connection, so a long-lived snapshot never hides another process's WAL commits.

Supported options:

```text
--once                 Poll once, emit the result, and exit
--interval <ms>        Poll interval in milliseconds; default 1000; integer from 100 to 60000 inclusive
--max-cycles <n>       Stop after n poll cycles
--timeout <ms>         Stop after a wall-clock duration, in milliseconds
--turn-limit <n>       Bound each poll to the newest n turns, reusing the get --turn-limit machinery (must be a positive integer, 0 is rejected)
--format jsonl|json    Output format; jsonl is the default
```

`--once` is mutually exclusive with `--interval`, `--max-cycles`, and `--timeout`. `--max-cycles` and `--timeout` are mutually usable together; whichever fires first stops the tail. With none of `--once`, `--max-cycles`, or `--timeout` given, the tail follows indefinitely until interrupted - this is the only unbounded loop in the package. `--format json` buffers the whole run into a single JSON array of records, so it requires a bounded tail (`--once`, `--max-cycles`, or `--timeout`); an unbounded tail with `--format json` is rejected because it would never finish.

Each line (or array element, for `--format json`) is a `t3-thread.tail-record.v1` record:

```text
schemaVersion   "t3-thread.tail-record.v1"
op              "upsert", "live-state", or "end"
recordType      "thread", "turn", "message", "activity", "live-state", or "end"
threadId        the tailed thread's ID
observedAt      the tool's own read timestamp for the cycle, ISO-8601 UTC
cycle           1-based poll cycle counter
data            the record payload
```

`upsert` means replace-by-identifier, not append: a record seen for the first time and a record whose content changed both arrive as `upsert`, so a consumer keys on the record's stable identifier and replaces rather than accumulating a log. Cycle 1 always emits the full baseline - a `thread` record, then every existing turn, message, and activity record - and later cycles emit `upsert` records only for what is new or changed. Records within a single cycle are in the same chronological order as normalized JSONL. A `live-state` record is emitted in cycle 1 and thereafter only when `liveState` changes. Exactly one `end` record is emitted when the tail stops, carrying a `reason` of `"once"`, `"max-cycles"`, `"timeout"`, `"interrupt"`, or `"thread-not-found"`.

Known limitation: deletions are out of scope for this increment. A record that disappears from the projection is not reported.

Interruption and failure behavior:

- **SIGINT** stops polling, emits the `end` record with reason `"interrupt"`, and exits 0.
- **A closed stdout**, for example under `head`, is handled quietly - no unhandled `EPIPE` error.
- **A busy or locked database** during a cycle is retried on the next cycle rather than killing the tail, up to three consecutive failures, with a machine-readable diagnostic written to stderr each time. The fourth consecutive failure exits 4, the same code as other database-unavailable errors.
- **A thread that disappears mid-tail** emits the `end` record with reason `"thread-not-found"` and exits 2, the same code `get` uses for a missing thread.
- **A missing thread at startup** behaves exactly like `get`: exit 2, nothing on stdout.

These exit codes match `get` and the rest of the CLI.

## Thread participants

```bash
t3-thread participants THREAD_ID --format json
t3-thread participants THREAD_ID --tree --format json
t3-thread participants THREAD_ID --turn TURN_ID --format jsonl
```

A participant is one `taskId` within one thread, folded from that thread's explicit `task.started`, `task.progress`, `task.completed`, and `task.updated` activities. The fold is last-non-null-wins per field: a later activity that omits a field does not erase the value an earlier activity set.

Supported options:

```text
--tree                 Emit a nested tree instead of a flat array
--last-turn            Only participants whose activities touch the newest turn
--turn <turn-id>       Only participants whose activities touch that turn
--turn-limit <n>       Only participants touching the newest n turns (must be a positive integer, 0 is rejected)
--turn-offset <n>      Skip turns from the newest side before --turn-limit
--limit <n>            Maximum participants returned; no default; must be a positive integer when given, 0 is rejected
--offset <n>           Skip matching participants before applying --limit
--reverse              Newest-first instead of the default oldest-first
--format human|json|jsonl
```

`--last-turn` is shorthand for a one-turn newest-side window (`selection.kind: "turn-window"`, `turnLimit: 1`, `turnOffset: 0`) - the same resolution `get --last-turn` uses. It shares `get`'s mutual-exclusivity rule: it cannot be combined with `--turn`, `--turn-limit`, or `--turn-offset`. An exact `--turn` that matches nothing follows the same rule `get` does: a `TURN_NOT_FOUND` warning, an empty `participants` array, and exit 2, with the full envelope still printed - see [Retrieve a thread](#retrieve-a-thread) above.

`--limit` has no default, so the full participant list is returned unless a smaller page is requested. `counts.total` is the number of participants matching before `--limit`/`--offset` is applied, so truncation is detectable; `counts.participants` is how many are actually returned in this page. `counts.roots`, `counts.withExplicitParent`, `counts.unresolvedParents`, and `hierarchyAvailable` describe every participant matching the current turn selection before paging, so they do not shrink when `--limit`/`--offset` does. With no turn selection that is the whole thread; with `--turn`, `--turn-limit`, `--turn-offset`, or `--last-turn` it is only the selected turns, so `hierarchyAvailable: false` on a bounded read does not mean the thread has no hierarchy elsewhere. `--tree` is rejected together with `--format jsonl`, because JSONL is a flat one-record-per-line contract and a nested tree cannot be expressed in it.

A `task.*` activity recorded with a null `turn_id` can never appear in a turn-bounded read (`--turn`, `--turn-limit`, `--turn-offset`, `--last-turn`) - SQL's `IN` list never matches `NULL`. This is deliberate and matches how `get` bounds its windows on `turn_id`. Real data has these: roughly 98 of 6,338 observed `task.*` rows. If an expected participant is missing from a bounded view, re-run without turn selection to see the whole thread.

Each participant carries `taskId`, `parentTaskId`, `path`, `depth`, `title`, `role`, `model`, `agentKind`, `taskType`, `effort`, `status`, `state`, `summary`, `detail`, `error`, `toolUseId`, `lastToolName`, `workflowName`, `outputFile`, `isBackgrounded`, `turnId`, `turnIds`, `firstSeenAt`, `lastSeenAt`, `activityCount`, and `usage`. Every field is always present; absent projection data yields `null`, never a missing key.

`state` is a small summary derived from the raw, projected `status`: `"finished"` when `status` is one of the terminal values (`completed`, `failed`, `stopped`, `cancelled`), `"running"` when a non-terminal or unrecognised status was recorded, and `"unknown"` when no status was ever projected. An unrecognised status is deliberately reported as `"running"` rather than `"finished"`, because claiming a still-running agent has finished is the more damaging error. `status: null` together with `state: "unknown"` means the projection never recorded a status for that task at all.

`usage` is normalized from whichever of `typedUsage` or the snake_case `usage` is present, preferring `typedUsage`. Unknown values stay `null` rather than becoming `0`, so "not reported" and "zero" remain distinguishable.

Anything the projection carries that this package does not model - `phases`, `runHandles`, `timelineBypass`, `usageSnapshot`, `attempt`, `agentIndex`, `phaseIndex`, `phaseTitle`, and similar - appears under `adapterSpecific`, never as a top-level field.

### Hierarchy

`parentTaskId` is populated **only** from an explicit, resolvable `parentAgentId` recorded on a contributing activity. Hierarchy is **never** inferred from timestamps, activity order, sequence, tool-use IDs, or identifier shape. Two tasks that merely ran next to each other are two roots.

`hierarchyAvailable` is the machine-readable signal to check before presenting a tree: it is `true` only when at least one participant has a resolved `parentTaskId`. For the great majority of real threads it is `false`, and that is the correct answer, not a failure - measured against a real local projection, an explicit parent link appeared on roughly 0.5 percent of task activities, in 1 thread out of 111.

`path` (for example `main.subagent1.subagent1a`) is present only when a participant's entire ancestry to a root is explicitly known; it is `null` when any ancestor is unresolved or cyclic. Sibling labels are assigned by the deterministic participant ordering below, but that ordering only assigns a label to an already-known child - it is not a way of inferring the parent/child edge itself, which always comes from `parentAgentId`.

`UNRESOLVED_PARENT` and `PARENT_CYCLE` warnings describe a projection that recorded a parent that does not resolve to a known participant, or that recorded contradictory parentage. In both cases the affected participants are reported as roots with a `null` path, rather than being dropped or given an invented placeholder parent. A task whose `parentAgentId` equals its own `taskId` resolves (the identifier does name a known participant), so it is reported as `PARENT_CYCLE`, a one-node cycle, not `UNRESOLVED_PARENT`. A task that is merely downstream of a cycle - not on the cycle itself - keeps its own explicit `parentTaskId`; it only loses its `path`, since ancestry through a broken link can no longer be confirmed. Only tasks actually on the cycle are demoted to roots and named in `PARENT_CYCLE`.

`PARENT_OUT_OF_PAGE` is specific to `--tree` combined with `--limit`/`--offset`: `counts` and `hierarchyAvailable` describe everything matching before paging, but a tree can only nest what the returned page contains. When a resolved parent falls outside the page, its child is surfaced at the top level instead of being dropped, and this warning names the affected child task IDs. This means `hierarchyAvailable: true` can legitimately accompany a visually flat or partial tree - check the warning, not just the shape of the output, before concluding the hierarchy is missing.

`PARENT_OUT_OF_SELECTION` is the equivalent for a turn selection (`--turn`, `--turn-limit`, `--turn-offset`, `--last-turn`): when a task's recorded parent is a real task in the thread but that parent's own activities fall outside the selected turns, the child keeps its real `parentTaskId`, gets `path: null`, is surfaced at the top level, and this warning names the affected child task IDs. `UNRESOLVED_PARENT` under a turn selection means only a parent that does not exist anywhere in the thread - re-run without a turn selection to tell the two cases apart.

### Ordering

Participants are ordered by `firstSeenAt`, then by `taskId` as a deterministic tie-breaker, oldest-first by default; `--reverse` flips both keys. A participant with a null `firstSeenAt` sorts last in **both** directions, the same null-timestamp rule `list` and `find` use - reversing a listing never floats an untimestamped participant to the front.

Sibling labels inside `path` are always assigned in ascending order regardless of `--reverse`, so changing the display order never renumbers a path.

A thread with no task activities returns a valid, empty envelope - `participants: []`, `counts.participants: 0`, `hierarchyAvailable: false` - not an error.

## Search and diagnose

Title search is trimmed, case-insensitive, parameterized, excludes deleted threads, and does not search message content:

```bash
t3-thread find --title "topic"
t3-thread find --title "topic" --format json
t3-thread find --title "topic" --reverse
```

`find` defaults to oldest-first chronological order, matching `list`; pass `--reverse` for newest-first. `find --format json` emits the `t3-thread.find.v1` envelope (`schemaVersion`, `toolVersion`, `filters.title`, `ordering`, `count`, `threads`), where each entry in `threads` is the same per-thread shape `list` returns. `find` supports `--format human` and `--format json` only, and has no `--limit`/`--offset` - it always returns every title match, so there is no `hasMore` to check. Use `list` instead when you need paging or filtering by project and time window.

**Breaking change:** `find --format json` returned a bare array in the published `0.1.0` release. A consumer written against that shape must switch to reading `.threads` from the envelope; see `CHANGELOG.md`.

Use doctor to inspect the expected installation without retrieving conversation content:

```bash
t3-thread doctor
t3-thread doctor --format json
```

Machine-readable data is written to stdout. Errors and raw JSONL partial-read diagnostics are written to stderr. The CLI uses stable exit codes and `t3-thread.error.v1` errors.

## Bundled schemas

Print a schema for validation or integration work:

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

The bundled schemas are versioned and are included in the npm package.

## Claude and Codex skill installation

The package includes a recovery skill at `skills/t3-thread/`: `SKILL.md`, `references/cli.md`, `references/workflows.md`, and `agents/openai.yaml` (a small Codex-style agent-interface metadata stub - display name, short description, default prompt - bundled alongside the skill; it is not part of the command reference). Install it for Claude or Codex:

```bash
t3-thread install --skills claude
t3-thread install --skills codex
```

The destinations mirror the `br0wser` convention:

- Claude: `~/.claude/skills/t3-thread`
- Codex: `$CODEX_HOME/skills/t3-thread`, or `~/.codex/skills/t3-thread` when `CODEX_HOME` is unset

The installer validates the packaged source and copies only the allowlisted bundle files. It never silently removes an existing destination. If the destination already exists, choose an explicit policy:

```bash
t3-thread install --skills claude --overwrite
t3-thread install --skills claude --backup
t3-thread install --skills codex --backup
```

`--overwrite` replaces only the resolved `t3-thread` skill directory. `--backup` moves the existing directory to a timestamped sibling backup before installing. The installer rejects invalid targets and does not accept a user-controlled destination path. A failed `install` - a destination that already exists with neither `--overwrite` nor `--backup`, or an invalid/conflicting target - exits 3 with a `t3-thread.error.v1` error, the same code used for other rejected-arguments cases.

## Privacy and read-only guarantees

The package opens SQLite read-only, allows SQLite WAL/SHM files to be used, and never writes projection data to T3 storage. SQLite may update existing WAL/SHM locking state while a read is active. It does not perform recursive discovery or broad filesystem searches. Use `--db` and temporary fixture homes for development and tests. Do not paste credentials, bearer tokens, private prompts, or unrelated local data into reports.

## Schema and compatibility policy

The normalized output is versioned as `t3-thread.thread.v1`. JSONL records are versioned as `t3-thread.jsonl-record.v1`, and machine-readable errors as `t3-thread.error.v1`. New fields may be added without changing existing field meanings; a breaking output change requires a new schema version. The public API and CLI commands remain stable across compatible releases. A new command gets its own schema rather than a breaking version bump on an existing one.

The package is pre-1.0. Where present, `toolVersion` tracks the package version, not a schema version - but it is not on every envelope: it appears on `thread.v1`, `list.v1`, `find.v1`, `participants.v1`, and the `doctor` report, and is absent from `error.v1`, `tail-record.v1`, and per-line `jsonl-record.v1` records, which carry `schemaVersion` only. Check the installed tool version with `t3-thread --version`.

See [`CHANGELOG.md`](CHANGELOG.md) for release history, schema decisions, and pre-1.0 corrections.

## Development

Run syntax validation and the built-in test suite:

```bash
npm run check
npm test
```

Tests use temporary fixture databases and sanitized provider records. They do not access a real user T3 home or real Claude/Codex skill directories. Review the release file list with:

```bash
npm pack --dry-run
```
