import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ACTIVE_THREAD_ID = "8833580e-bef2-4ece-8fde-cbacbc58650f";
export const DELETED_THREAD_ID = "deleted-thread-0001";
export const ORPHAN_THREAD_ID = "orphan-thread-0001";
export const NULL_FIELD_PROJECT_THREAD_ID = "null-field-project-thread-0001";
export const WINDOW_THREAD_ID = "window-thread-0001";
export const TIE_THREAD_A_ID = "tie-thread-a";
export const TIE_THREAD_B_ID = "tie-thread-b";
export const NULL_UPDATED_THREAD_ID = "null-updated-thread-0001";
export const DELETED_PROJECT_TWO_THREAD_ID = "deleted-project-two-thread-0001";
export const PROJECT_TWO_TITLE = "CodeLaunch";

export function createFixtureDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-thread-"));
  const databasePath = path.join(directory, "state.sqlite");
  const database = new DatabaseSync(databasePath);

  database.exec(`
    CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY,
      title TEXT,
      workspace_root TEXT
    );
    CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT,
      branch TEXT,
      worktree_path TEXT,
      latest_turn_id TEXT,
      created_at TEXT,
      updated_at TEXT,
      latest_user_message_at TEXT,
      deleted_at TEXT,
      runtime_mode TEXT,
      interaction_mode TEXT,
      model_selection_json TEXT
    );
    CREATE TABLE projection_thread_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT,
      turn_id TEXT,
      role TEXT,
      text TEXT,
      is_streaming INTEGER,
      created_at TEXT,
      updated_at TEXT,
      attachments_json TEXT
    );
    CREATE TABLE projection_thread_activities (
      activity_id TEXT PRIMARY KEY,
      thread_id TEXT,
      turn_id TEXT,
      tone TEXT,
      kind TEXT,
      summary TEXT,
      payload_json TEXT,
      created_at TEXT,
      sequence INTEGER
    );
    CREATE TABLE projection_thread_sessions (
      thread_id TEXT PRIMARY KEY,
      provider_name TEXT,
      provider_session_id TEXT,
      provider_thread_id TEXT,
      provider_instance_id TEXT,
      status TEXT,
      last_error TEXT
    );
    CREATE TABLE projection_turns (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT,
      turn_id TEXT,
      pending_message_id TEXT,
      source_proposed_plan_thread_id TEXT,
      source_proposed_plan_id TEXT,
      assistant_message_id TEXT,
      state TEXT,
      requested_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      checkpoint_turn_count INTEGER,
      checkpoint_ref TEXT,
      checkpoint_status TEXT,
      checkpoint_files_json TEXT
    );
  `);

  const project = database.prepare(
    "INSERT INTO projection_projects (project_id, title, workspace_root) VALUES (?, ?, ?)",
  );
  project.run("project-1", "Sanitized project", "/tmp/sanitized-workspace");
  project.run("project-null-fields", null, null);
  project.run("project-2", PROJECT_TWO_TITLE, "/tmp/codelaunch-workspace");

  const thread = database.prepare(`
    INSERT INTO projection_threads (
      thread_id, project_id, title, branch, worktree_path, latest_turn_id,
      created_at, updated_at, latest_user_message_at, deleted_at, runtime_mode,
      interaction_mode, model_selection_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  thread.run(
    ACTIVE_THREAD_ID,
    "project-1",
    "Sanitized recovery thread",
    "main",
    "/tmp/sanitized-worktree",
    "turn-2",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:02:00.000Z",
    "2026-01-01T00:01:00.000Z",
    null,
    "full-access",
    "default",
    '{"provider":"sanitized-model","options":{"temperature":0}}',
  );
  thread.run(
    DELETED_THREAD_ID,
    "project-1",
    "Deleted sanitized thread",
    null,
    null,
    null,
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:01:00.000Z",
    null,
    "2026-01-01T00:02:00.000Z",
    null,
    null,
    null,
  );
  thread.run(
    ORPHAN_THREAD_ID,
    "missing-project",
    "Orphan sanitized thread",
    null,
    null,
    null,
    "2026-01-02T00:00:00.000Z",
    "2026-01-02T00:01:00.000Z",
    null,
    null,
    null,
    null,
    null,
  );
  thread.run(
    NULL_FIELD_PROJECT_THREAD_ID,
    "project-null-fields",
    "Null-field project thread",
    null,
    null,
    null,
    "2026-01-03T00:00:00.000Z",
    "2026-01-03T00:01:00.000Z",
    null,
    null,
    null,
    null,
    null,
  );
  thread.run(
    WINDOW_THREAD_ID,
    "project-2",
    "Windowed sanitized thread",
    "feature",
    "/tmp/codelaunch-worktree",
    "wturn-3",
    "2026-02-01T00:00:00.000Z",
    "2026-02-01T00:03:00.000Z",
    "2026-02-01T00:02:10.000Z",
    null,
    "full-access",
    "default",
    null,
  );
  thread.run(
    TIE_THREAD_A_ID,
    "project-2",
    "Tie sanitized thread A",
    null,
    null,
    null,
    "2026-02-02T00:00:00.000Z",
    "2026-02-02T00:00:00.000Z",
    null,
    null,
    null,
    null,
    null,
  );
  thread.run(
    TIE_THREAD_B_ID,
    "project-2",
    "Tie sanitized thread B",
    null,
    null,
    null,
    "2026-02-02T00:00:00.000Z",
    "2026-02-02T00:00:00.000Z",
    null,
    null,
    null,
    null,
    null,
  );
  thread.run(
    NULL_UPDATED_THREAD_ID,
    "project-2",
    "Null updated sanitized thread",
    null,
    null,
    null,
    "2026-02-03T00:00:00.000Z",
    null,
    null,
    null,
    null,
    null,
    null,
  );
  thread.run(
    DELETED_PROJECT_TWO_THREAD_ID,
    "project-2",
    "Deleted CodeLaunch thread",
    null,
    null,
    null,
    "2026-02-04T00:00:00.000Z",
    "2026-02-04T00:01:00.000Z",
    null,
    "2026-02-04T00:02:00.000Z",
    null,
    null,
    null,
  );

  const turn = database.prepare(`
    INSERT INTO projection_turns (
      thread_id, turn_id, pending_message_id, source_proposed_plan_thread_id,
      source_proposed_plan_id, assistant_message_id, state, requested_at, started_at,
      completed_at, checkpoint_turn_count, checkpoint_ref, checkpoint_status,
      checkpoint_files_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  turn.run(
    ACTIVE_THREAD_ID,
    "turn-2",
    null,
    null,
    null,
    "assistant-2",
    "completed",
    "2026-01-01T00:01:00.000Z",
    "2026-01-01T00:01:01.000Z",
    "2026-01-01T00:02:00.000Z",
    2,
    "checkpoint-2",
    "ready",
    '[{"path":"safe.txt"}]',
  );
  turn.run(
    ACTIVE_THREAD_ID,
    "turn-1",
    "user-1",
    null,
    null,
    "assistant-1",
    "completed",
    "2026-01-01T00:00:01.000Z",
    "2026-01-01T00:00:02.000Z",
    "2026-01-01T00:00:59.000Z",
    1,
    null,
    null,
    "[]",
  );
  // Inserted out of chronological order so turn windows cannot rely on row_id.
  turn.run(
    WINDOW_THREAD_ID,
    "wturn-2",
    "wuser-2",
    null,
    null,
    "wassistant-2",
    "completed",
    "2026-02-01T00:01:10.000Z",
    "2026-02-01T00:01:11.000Z",
    "2026-02-01T00:01:20.000Z",
    2,
    null,
    null,
    null,
  );
  turn.run(
    WINDOW_THREAD_ID,
    "wturn-3",
    "wuser-3",
    null,
    null,
    null,
    "streaming",
    "2026-02-01T00:02:10.000Z",
    "2026-02-01T00:02:11.000Z",
    null,
    3,
    null,
    null,
    null,
  );
  turn.run(
    WINDOW_THREAD_ID,
    "wturn-1",
    "wuser-1",
    null,
    null,
    "wassistant-1",
    "completed",
    "2026-02-01T00:00:10.000Z",
    "2026-02-01T00:00:11.000Z",
    "2026-02-01T00:00:20.000Z",
    1,
    null,
    null,
    null,
  );

  const message = database.prepare(`
    INSERT INTO projection_thread_messages (
      message_id, thread_id, turn_id, role, text, is_streaming, created_at,
      updated_at, attachments_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  message.run(
    "message-2",
    ACTIVE_THREAD_ID,
    "turn-2",
    "assistant",
    "Second sanitized answer",
    0,
    "2026-01-01T00:02:00.000Z",
    "2026-01-01T00:02:01.000Z",
    "not-json",
  );
  message.run(
    "message-1",
    ACTIVE_THREAD_ID,
    "turn-1",
    "user",
    "First sanitized question",
    0,
    "2026-01-01T00:01:00.000Z",
    "2026-01-01T00:01:00.000Z",
    '[{"name":"safe.txt"}]',
  );
  // Projected user prompts carry a null turn_id and are reachable through pending_message_id.
  message.run(
    "wuser-1", WINDOW_THREAD_ID, null, "user", "Windowed question one",
    0, "2026-02-01T00:00:10.000Z", "2026-02-01T00:00:10.000Z", null,
  );
  message.run(
    "wassistant-1", WINDOW_THREAD_ID, "wturn-1", "assistant", "Windowed answer one",
    0, "2026-02-01T00:00:20.000Z", "2026-02-01T00:00:20.000Z", null,
  );
  message.run(
    "wuser-2", WINDOW_THREAD_ID, null, "user", "Windowed question two",
    0, "2026-02-01T00:01:10.000Z", "2026-02-01T00:01:10.000Z", null,
  );
  message.run(
    "wassistant-2", WINDOW_THREAD_ID, "wturn-2", "assistant", "Windowed answer two",
    0, "2026-02-01T00:01:20.000Z", "2026-02-01T00:01:20.000Z", null,
  );
  message.run(
    "wuser-3", WINDOW_THREAD_ID, null, "user", "Windowed question three",
    0, "2026-02-01T00:02:10.000Z", "2026-02-01T00:02:10.000Z", null,
  );
  message.run(
    "wextra-3", WINDOW_THREAD_ID, "wturn-3", "assistant", "Windowed streaming answer",
    1, "2026-02-01T00:02:15.000Z", "2026-02-01T00:02:16.000Z", null,
  );

  const activity = database.prepare(`
    INSERT INTO projection_thread_activities (
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
      created_at, sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  activity.run(
    "activity-2",
    ACTIVE_THREAD_ID,
    "turn-2",
    "info",
    "tool",
    "Second activity",
    "{\"tool\":\"safe\"}",
    "2026-01-01T00:02:00.000Z",
    2,
  );
  activity.run(
    "activity-1",
    ACTIVE_THREAD_ID,
    "turn-1",
    "info",
    "status",
    "First activity",
    "not-json",
    "2026-01-01T00:01:00.000Z",
    1,
  );
  activity.run(
    "wactivity-1", WINDOW_THREAD_ID, "wturn-1", "info", "tool",
    "Window activity one", null, "2026-02-01T00:00:15.000Z", 1,
  );
  activity.run(
    "wactivity-2", WINDOW_THREAD_ID, "wturn-2", "info", "tool",
    "Window activity two", null, "2026-02-01T00:01:15.000Z", 2,
  );
  activity.run(
    "wactivity-3", WINDOW_THREAD_ID, "wturn-3", "info", "tool",
    "Window activity three", null, "2026-02-01T00:02:12.000Z", 3,
  );
  // Not associated with any turn, so no turn window may include it.
  activity.run(
    "wactivity-unassociated", WINDOW_THREAD_ID, null, "info", "status",
    "Unassociated window activity", null, "2026-02-01T00:02:30.000Z", 4,
  );

  const session = database.prepare(`
    INSERT INTO projection_thread_sessions (
      thread_id, provider_name, provider_session_id, provider_thread_id,
      provider_instance_id, status, last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  session.run(ACTIVE_THREAD_ID, "SanitizedProvider", null, null, "instance-1", "ready", null);
  session.run(WINDOW_THREAD_ID, "SanitizedProvider", null, null, "instance-2", "running", null);

  database.close();
  return { directory, databasePath };
}
