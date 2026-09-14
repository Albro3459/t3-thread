# Changelog

Notable changes to `t3-thread`, by release. The package is pre-1.0; see the "Schema and
compatibility policy" section of `README.md` for the rules governing schema versioning.

## 0.2.1

- Renamed `t3-session` to `t3-thread` to better describe the tool.

## 0.2.0

`0.1.0` published with `get`, `find`, `doctor`, `schema`, and `install --skills` only - no `list`
command, no bounded `get`, no `liveState`, no `tail`, and no `participants`. All of those ship for
the first time in `0.2.0`.

### Added

- `list` command: paginated thread listing (`--project/--since/--before/--limit/--offset/--reverse`),
  new `t3-session.list.v1` envelope, matching `listThreads` API.
- Bounded `get`: `--last-turn/--turn/--turn-limit/--turn-offset` retrieve a window of turns instead
  of full history. Adds the additive `selection` field to `thread.v1`; full retrieval is unaffected.
- `liveState`: an always-present property on `thread.v1` describing whether a thread appears to
  still be changing, derived only from projected signals (turn state, streaming messages, provider
  session status), never from timestamp recency.
- `tail` command: polls the SQLite projection read-only and emits `upsert`/`live-state`/`end`
  records against the new `t3-session.tail-record.v1` schema.
- `participants` command: folds `task.*` activities into one entry per `taskId`, resolves hierarchy
  from explicit `parentAgentId` links only, and reports it under the new `t3-session.participants.v1`
  schema. `"participants"`/`"participant"` were added to the `t3-session.jsonl-record.v1`
  `recordType` enum as an additive change. Participants are a separate command rather than a third
  array on `thread.v1`, so `get` output is unaffected.
- `PARENT_OUT_OF_SELECTION` warning: under a turn selection (`--turn/--turn-limit/--turn-offset/
  --last-turn`), a task whose recorded parent is real but whose own activities fall outside the
  selected turns is now reported with its real `parentTaskId`, `path: null`, at the top level, and
  named in this warning - distinct from `UNRESOLVED_PARENT`, which now means only a parent that does
  not exist anywhere in the thread.
- `TURN_NOT_FOUND` warning: an exact `--turn <turn-id>` that matches no turn, on either `get` or
  `participants`, now emits a `TURN_NOT_FOUND` warning (`details.turnId`) and exits 2, while still
  printing the complete envelope on stdout - the same emit-then-exit-non-zero pattern `doctor` uses.
  A turn-*window* page past the end (`--turn-limit`/`--turn-offset`/`--last-turn`) is unaffected and
  stays a silent, valid empty page: no warning, exit 0.
- Two new bundled schemas: `doctor.v1` (the `doctor` report now has a printable schema behind its
  `schemaVersion`) and `find.v1` (see Breaking, below). Both are `t3-session schema`-printable and
  ship in `schemas/`.

### Breaking

- **`find --format json` is now an envelope, not a bare array.** It emits `t3-session.find.v1`:
  `schemaVersion`, `toolVersion`, `filters.title`, `ordering` (`sortBy: "updatedAt"`, `direction`),
  `count`, and `threads` - where each `threads` entry is the same per-thread shape `list` returns.
  `find` shipped a bare array of matches in the published `0.1.0` release; a consumer parsing that
  shape directly must migrate to reading `.threads` from the envelope. `find` still has no
  `--limit`/`--offset`, so there is deliberately no `limit`/`offset`/`hasMore` on the envelope.
- **`--limit`, `--turn-limit`, and participants' `--limit` now require a positive integer.** A value
  of `0` - previously accepted and silently returned nothing - is now rejected with
  `"<field> must be a positive integer."` and exit 3. Offsets (`--offset`, `--turn-offset`) are
  unchanged and still accept `0`. Anyone passing `--limit 0` (or `--turn-limit 0`) to get an
  intentionally empty result must switch to filtering the returned page instead.

### Fixed

- `--since`/`--before` accept an offset-less ISO-8601 date-time - including the space-separated form
  (`2026-08-10 09:00`) - and interpret it as UTC, matching the date-only form and UTC storage,
  instead of the host's local timezone.
- A negative value on any numeric option (`--limit -1`, `--offset -1`, `--turn-limit -1`, and so on)
  now reports itself: `"<option> does not accept a negative value."` It previously fell through to
  the misleading `"Missing value for <option>."`, which is now reserved for an actually-absent value.

No *existing* schema version changed with this release: `thread.v1`, `list.v1`, `tail-record.v1`,
`jsonl-record.v1`, and `participants.v1` are all unchanged from their initial definitions. `doctor.v1`
and `find.v1` are new schemas, not changes to existing ones.

### Pre-1.0 corrections

Behavior changes versus `0.1.0`, called out because they change output shape or ordering:

- Normalized JSONL (`get --format jsonl`) changed from grouped order (all turns, then all messages,
  then all activities) to chronological order by event timestamp.
- `find`'s default order changed from newest-first (`updated_at` descending) to oldest-first
  chronological, matching `list`; pass `--reverse` to restore newest-first. Ties now break
  deterministically on `thread_id`.
- `liveState` is a new always-present property on `thread.v1`, so `get --format json` output is no
  longer byte-identical to `0.1.0` output. Accepted as an additive change for a pre-1.0 package; it
  does not create a `thread.v2`.

## 0.1.0

First published release. Commands: `get`, `find`, `doctor`, `schema`, `install --skills`. `get`
retrieves full thread history only, with no bounded-window options.
