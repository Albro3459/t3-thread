# t3-thread Workflows

Assume the CLI is installed and the thread ID comes from the current task context. Keep examples sanitized and do not substitute arbitrary filesystem searches for the documented paths.

## Find a thread without an exact ID

Use `list` to identify a candidate instead of guessing a thread ID:

```bash
t3-thread list --reverse --limit 20 --format json
t3-thread list --project "Example Project" --since 2026-08-10 --format json
```

Narrow with `--project`, `--since`, `--before`, `--limit`, and `--offset` so the returned page stays small. `--reverse` returns the most recently updated threads first. Read `hasMore` in the response to know whether to page further with `--offset` rather than widening `--limit` unnecessarily. `list` output is metadata only (title, project, branch, worktree path, timestamps) - it never contains message or activity text, so it is safe to inspect broadly before committing to one thread ID.

## Confirm before full retrieval

Before retrieving the complete history of a candidate thread, confirm it with a bounded read:

```bash
t3-thread get THREAD_ID --last-turn --format json
```

Check the thread metadata, the latest turn, and the most recent user prompt (included via `pending_message_id` even though projected user messages carry a null `turn_id`). Only run the full `t3-thread get THREAD_ID` once the candidate is confirmed. Any response carrying a `selection` object is partial history - state that explicitly and do not present it as the full conversation. `t3-thread get THREAD_ID --turn-limit 3 --format jsonl` is useful when a slightly larger recent window, still bounded, is needed instead of a single turn.

## Standard recovery loop

1. Check the installation without reading conversation data:

   ```bash
   t3-thread doctor --format json
   ```

2. Retrieve the exact thread using the normalized projection:

   ```bash
   t3-thread get THREAD_ID --format json
   ```

3. Inspect `thread`, `turns`, `messages`, `activities`, `provider`, and `warnings` together. Preserve null values and warnings.

4. If another tool needs streaming records, use:

   ```bash
   t3-thread get THREAD_ID --format jsonl
   ```

5. Use provider events only for a targeted gap:

   ```bash
   t3-thread get THREAD_ID --raw-jsonl
   ```

   Valid records remain available when individual provider lines are malformed. A nonzero exit code and stderr warning must be reported rather than hidden.

## Missing database or schema

Run doctor first. If the database is unavailable or required projection tables are missing, report the resolved condition. Do not search browser profiles, IndexedDB, LevelDB, full-disk paths, cloud APIs, or unrelated logs. The CLI intentionally fails clearly instead of guessing.

## Missing thread

A missing exact ID is not a title-search result. Use title search only when the task provides a title:

```bash
t3-thread find --title "sanitized topic" --format json
```

Confirm the returned ID before retrieving it. Deleted threads are excluded from title search and exact retrieval.

## Empty list page

An empty `threads` array from `list` can mean the offset ran past the end of the result set, or that `--since`/`--before` excluded threads with a null `updated_at` (a null timestamp cannot satisfy either bound). Check `count`, `hasMore`, `limit`, and `offset` in the response before concluding there is no match. Retry with a smaller `--offset`, a wider `--since`/`--before` window, or without `--since`/`--before` entirely.

## An exact --turn matches nothing

`get THREAD_ID --turn TURN_ID` and `participants THREAD_ID --turn TURN_ID` treat a turn ID that does not exist in the thread as a reportable condition, not a silent empty result: the envelope still comes back in full, but with a `TURN_NOT_FOUND` warning in `warnings` (`details.turnId` names the ID that missed) and exit code 2.

```bash
t3-thread get THREAD_ID --turn TURN_ID --format json
```

This is different from a turn-*window* (`--turn-limit`, `--turn-offset`, `--last-turn`) whose page lands past the end of the thread - that case is a valid empty page, exactly like an empty `list` page: no warning, exit 0. Before concluding a turn ID is wrong, confirm which kind of selection produced the empty result - check `warnings`, not just whether `turns`/`participants` came back empty. Do not retry an exact `--turn` miss by guessing another ID; report the mismatch and ask for the correct turn ID or re-run without turn selection.

## Project filter matches nothing

`--project` is an exact, case-insensitive match on the trimmed project title, not a substring search. If it returns nothing, retry `t3-thread list` without `--project` and inspect the `project.title` values in the results, or use `t3-thread find --title "..."` for substring matching against thread titles.

## Active or partially persisted thread

The SQLite projection can lag a turn that is still in progress. Every `get` result carries a `liveState` object; check `liveState.complete` before summarizing a thread, and report the projection's contents honestly - including any `state` on the newest turn, `liveState.reasons`, and any `warnings`. Do not present an in-flight turn as finished just because it appears in the output.

```bash
t3-thread get THREAD_ID --format json
```

If `liveState.complete` is `false`, follow with a bounded tail rather than re-polling `get` by hand:

```bash
t3-thread tail THREAD_ID --once --format jsonl
t3-thread tail THREAD_ID --max-cycles 5 --turn-limit 2 --format jsonl
```

`tail --once` answers "what does the thread look like right now, including anything that changed since I last checked." A bounded `--max-cycles` or `--timeout` tail follows the thread for a limited window inside an automated workflow; never start an unbounded tail (no `--once`, `--max-cycles`, or `--timeout`) outside an interactive session where a human can interrupt it. Treat every `upsert` record as replace-by-identifier, not append, and rely on the chronological order within each cycle instead of re-sorting.

### A thread that never becomes complete

`liveState.reasons` explains why `complete` is `false`:

- `"turn-not-terminal"` - the latest turn's state is not one of the known terminal states. An unrecognized turn state is deliberately treated as non-terminal, since guessing that an unfamiliar state means "finished" is the more damaging error.
- `"streaming-message"` - at least one message row is still marked streaming.
- `"provider-active"` - the provider session status itself is an active-looking value.

If a thread stays incomplete across repeated checks, report it as still active and describe which reasons are present - do not wait indefinitely for `complete` to become `true`, and do not infer completion from elapsed time.

### A tail that emits nothing

Cycle 1 of a tail always emits a full baseline (a `thread` record, every existing turn/message/activity record, and a `live-state` record). If later cycles emit no data records, that means nothing changed in the projection - it does not mean the tail is broken. To get a definite, one-shot answer instead of waiting on a live interval, use `--once` or a small `--max-cycles`:

```bash
t3-thread tail THREAD_ID --once --format jsonl
```

### A busy or locked database during a tail

A busy or locked SQLite database on one poll cycle does not kill the tail; it is retried on the next cycle, up to three consecutive failures, with a machine-readable diagnostic written to stderr on each attempt while stdout stays clean. The fourth consecutive failure exits 4. Report the failure and the stderr diagnostics rather than looping the CLI manually to retry - the tail already retries within its own bounds, and a fourth failure is a real condition to surface, not something to paper over.

## Who worked on this thread

Use `participants` instead of guessing from message text or tool activity when the task is "who worked on this thread" or "what did each agent do":

```bash
t3-thread participants THREAD_ID --format json
```

Check `hierarchyAvailable` before presenting anything as a tree. It is `false` for the great majority of real threads - that is the correct, expected answer, not a failure, so say so plainly rather than implying the data is missing or broken. Only ask for a tree once `hierarchyAvailable` is confirmed:

```bash
t3-thread participants THREAD_ID --tree --format json
```

Never claim one agent invoked another unless `parentTaskId` is populated on the child. Hierarchy comes only from an explicit, resolvable `parentAgentId` recorded in the projection - never from timestamps, activity order, or how similar two task IDs look. Two tasks that merely ran close together in time are two roots, not parent and child.

For a quick summary, use each participant's `state` (`"finished"`, `"running"`, or `"unknown"`) rather than the raw `status`, and report `"unknown"` honestly instead of guessing that a task finished.

Report `UNRESOLVED_PARENT`, `PARENT_CYCLE`, and `PARENT_OUT_OF_SELECTION` warnings if present rather than hiding them - full definitions and a comparison table are in `references/cli.md`. Quick distinction:

- `UNRESOLVED_PARENT` - the recorded parent does not resolve to any task anywhere in the thread (data problem).
- `PARENT_OUT_OF_SELECTION` - the parent resolves to a real task, just one whose own activities fall outside the current `--turn`/`--turn-limit`/`--turn-offset`/`--last-turn` window (narrow-window problem, not corruption); the child keeps `parentTaskId` but gets `path: null` and is reported at the top level.
- `PARENT_CYCLE` - contradictory parentage forms a loop, including a task naming itself as its own parent (a one-node cycle, reported as `PARENT_CYCLE`, not `UNRESOLVED_PARENT`). A task merely downstream of a cycle keeps its own explicit `parentTaskId` and loses only its `path` - only tasks actually on the cycle are demoted to roots.

On a participant-heavy thread, bound the view instead of loading everything:

```bash
t3-thread participants THREAD_ID --last-turn --format json
t3-thread participants THREAD_ID --turn TURN_ID --format jsonl
```

`--last-turn`, `--turn`, `--turn-limit`, or `--limit` keep the response small; real threads have been observed with 261 distinct tasks.

Watch `counts` when paging - `references/cli.md` has the full field-by-field table. Short version:

- `counts.total` vs. `counts.participants` differ exactly when `--limit`/`--offset` truncated the result.
- `counts.roots`, `counts.withExplicitParent`, `counts.unresolvedParents`, and `hierarchyAvailable` are all computed before paging (so they never shrink because of `--limit`/`--offset`) but are narrowed by an active turn selection (so they describe only the selected turns, not necessarily the whole thread).
- Don't read a small page's `counts` as a claim about the whole thread, and don't read a turn-bounded `counts` as a claim about turns outside the selection.

### A thread with no participants

An empty `participants` array means no `task.*` activities were projected for that thread - normal for a thread with no subagent or background work. Report that plainly rather than implying something failed or was lost.

### A tree that is unexpectedly flat

`hierarchyAvailable: false` means the projection never recorded an explicit parent for any participant. Do not reconstruct nesting from timestamps, activity order, or task ID similarity - report the flat list and say hierarchy is unavailable for this thread.

A visually flat or partial tree can also happen with `hierarchyAvailable: true`, when `--tree` is combined with `--limit`/`--offset` and a resolved parent falls outside the returned page. That case carries a `PARENT_OUT_OF_PAGE` warning naming the affected child task IDs, and the child is surfaced at the top level rather than dropped. Check for that warning before concluding the projection has no hierarchy - widen or remove `--limit`/`--offset` to see the full nesting.

### A participant missing from a bounded view

`--turn`, `--turn-limit`, `--turn-offset`, and `--last-turn` all bound participants to activities tagged with specific turn IDs. A `task.*` activity recorded with a null `turn_id` can never match that bound, so it never appears in a turn-bounded read - this is deliberate, the same rule `get`'s turn-bounded windows follow, and not a bug. If a participant you expect is missing from a bounded view, re-run `participants` without any turn-selection option to see the whole thread before concluding the participant is absent.

The same applies to a *parent*: a child can still appear in a bounded view (with `parentTaskId` populated) while its parent's own activities sit outside the window. That case is called out explicitly by a `PARENT_OUT_OF_SELECTION` warning rather than left for you to notice from a missing tree branch.

### A participant stuck in `running`

A participant reported with `state: "running"` may simply have ended without a terminal status ever being projected, rather than still being active. Cross-check the thread's `liveState.complete`, but treat it as a signal, not proof: `complete: true` means the projection shows no in-flight signal, which usually explains a stuck `"running"` participant as a status that never got finalized - it is not a guarantee that no agent is still working, since the upstream projection can mark a turn `completed` while an agent is still mid-turn. Report both readings rather than asserting the thread has settled.

## Partial provider history

A raw provider file can contain valid records, empty lines, unsupported labels, or malformed JSON. Keep valid record order, include the warning details, and state that the raw stream is partial. Do not treat token usage or delta events as a replacement for projected messages when the SQLite projection is available.

## Output discipline

- Keep JSON and JSONL stdout clean for machine consumers.
- Treat stderr as diagnostics, not conversation content.
- Never print credentials, tokens, private prompts, or unrelated local paths.
- Never write to the T3 home, SQLite database, WAL/SHM files, or provider logs.
- Use a temporary fixture home and an explicit `--db` path when developing or testing.
