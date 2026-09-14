import { resolveConfig, resolveProviderLogPath, validateThreadId } from "./config.js";
import { inspectInstallation } from "./doctor.js";
import {
  normalizeThread,
  normalizeThreadList,
  normalizeThreadSearchResult,
} from "./normalize.js";
import { normalizeParticipants } from "./participants.js";
import { readProviderJsonl } from "./provider-jsonl.js";
import {
  normalizeListOptions,
  normalizeParticipantOptions,
  normalizeTailOptions,
  normalizeTurnSelection,
} from "./query-options.js";
import {
  findThreadsFromDatabase,
  listThreadRowsFromDatabase,
  readParticipantActivitiesFromDatabase,
  readThreadFromDatabase,
  readThreadWindowFromDatabase,
} from "./sqlite-store.js";
import { tailThreadRecords } from "./tail.js";
import { VERSION } from "./version.js";

export { VERSION };

export async function createT3ThreadClient(options = {}) {
  const config = resolveConfig(options);
  const clientNow = typeof options.now === "function" ? options.now : Date.now;

  function observationTimestamp(requestOptions) {
    const now = typeof requestOptions.now === "function" ? requestOptions.now : clientNow;
    return new Date(now()).toISOString();
  }

  return Object.freeze({
    config,
    async getThread(threadId, requestOptions = {}) {
      validateThreadId(threadId);
      const selection = normalizeTurnSelection(requestOptions);
      const databasePath = requestOptions.db || requestOptions.stateDb || config.stateDb;
      const observedAt = observationTimestamp(requestOptions);
      if (selection === null) {
        return normalizeThread(readThreadFromDatabase(databasePath, threadId), {
          toolVersion: VERSION,
          observedAt,
        });
      }

      const rows = readThreadWindowFromDatabase(databasePath, threadId, selection);
      return normalizeThread(rows, {
        toolVersion: VERSION,
        selection: rows.selection,
        observedAt,
      });
    },
    // Returns an async iterable of t3-thread.tail-record.v1 objects. Not async itself, so
    // option validation throws before any iteration and before SQLite is opened.
    tailThread(threadId, requestOptions = {}) {
      validateThreadId(threadId);
      const tailOptions = normalizeTailOptions(requestOptions);
      const databasePath = requestOptions.db || requestOptions.stateDb || config.stateDb;
      return tailThreadRecords(threadId, {
        databasePath,
        tailOptions,
        toolVersion: VERSION,
        signal: requestOptions.signal,
        now: typeof requestOptions.now === "function" ? requestOptions.now : clientNow,
        sleep: requestOptions.sleep,
        onDiagnostic: requestOptions.onDiagnostic,
        readCycle: requestOptions.readCycle,
      });
    },
    async listParticipants(threadId, requestOptions = {}) {
      validateThreadId(threadId);
      const participantOptions = normalizeParticipantOptions(requestOptions);
      const databasePath = requestOptions.db || requestOptions.stateDb || config.stateDb;
      const rows = readParticipantActivitiesFromDatabase(
        databasePath,
        threadId,
        participantOptions.selection,
      );
      return normalizeParticipants(rows, {
        toolVersion: VERSION,
        threadId,
        options: participantOptions,
      });
    },
    async listThreads(requestOptions = {}) {
      const listOptions = normalizeListOptions(requestOptions);
      const databasePath = requestOptions.db || requestOptions.stateDb || config.stateDb;
      const { rows, hasMore } = listThreadRowsFromDatabase(databasePath, listOptions);
      return normalizeThreadList(rows, {
        toolVersion: VERSION,
        options: listOptions,
        hasMore,
      });
    },
    async findThreads(requestOptions = {}) {
      const reverse = requestOptions.reverse === true;
      const databasePath = requestOptions.db || requestOptions.stateDb || config.stateDb;
      const rows = findThreadsFromDatabase(databasePath, requestOptions.title, { reverse });
      return normalizeThreadSearchResult(rows, {
        toolVersion: VERSION,
        title: requestOptions.title,
        reverse,
      });
    },
    async readRawJsonl(threadId, requestOptions = {}) {
      validateThreadId(threadId);
      void requestOptions;
      const providerLogPath = resolveProviderLogPath(config, threadId);
      return readProviderJsonl(providerLogPath, { threadId });
    },
    async doctor(requestOptions = {}) {
      const databasePath = requestOptions.db || requestOptions.stateDb || config.stateDb;
      const doctorConfig = requestOptions.home === undefined
        ? { ...config, stateDb: databasePath }
        : resolveConfig({ home: requestOptions.home, db: databasePath });
      return inspectInstallation({ config: doctorConfig, toolVersion: VERSION });
    },
  });
}

export { resolveConfig, resolveProviderLogPath, validateThreadId } from "./config.js";
export {
  ConfigurationError,
  DatabaseUnavailableError,
  EXIT_CODES,
  InvalidArgumentsError,
  NotImplementedError,
  ProviderLogUnavailableError,
  RawJsonlPartiallyUnreadableError,
  SchemaUnavailableError,
  T3ThreadError,
  ThreadNotFoundError,
  UnknownCommandError,
  serializeError,
} from "./errors.js";
export {
  ACTIVE_PROVIDER_STATUSES,
  FIND_SCHEMA_VERSION,
  isActiveProviderStatus,
  isTerminalTurnState,
  LIST_SCHEMA_VERSION,
  LIVE_STATE_REASONS,
  normalizeLiveState,
  normalizeThread,
  normalizeThreadList,
  normalizeThreadSearchResult,
  normalizeThreadSummary,
  parseJsonField,
  SCHEMA_VERSION,
  TERMINAL_TURN_STATES,
} from "./normalize.js";
export {
  buildParticipantTree,
  isTerminalTaskStatus,
  normalizeParticipants,
  PARTICIPANTS_SCHEMA_VERSION,
  TASK_ACTIVITY_KINDS,
  TERMINAL_TASK_STATUSES,
} from "./participants.js";
export {
  DEFAULT_LIST_LIMIT,
  DEFAULT_TAIL_INTERVAL_MS,
  DEFAULT_TURN_LIMIT,
  MAX_TAIL_INTERVAL_MS,
  MIN_TAIL_INTERVAL_MS,
  normalizeCount,
  normalizeListOptions,
  normalizeParticipantOptions,
  normalizePositiveCount,
  normalizeProjectFilter,
  normalizeTailOptions,
  normalizeTimestamp,
  normalizeTurnSelection,
} from "./query-options.js";
export {
  buildSortableEntry,
  chronologicalThreadEntries,
  compareSortableEntries,
  RECORD_TYPE_RANK,
} from "./record-order.js";
export {
  MAX_CONSECUTIVE_READ_FAILURES,
  TAIL_END_REASONS,
  TAIL_OPERATIONS,
  TAIL_RECORD_TYPES,
  TAIL_SCHEMA_VERSION,
  tailThreadRecords,
} from "./tail.js";
export {
  DOCTOR_SCHEMA_VERSION,
  doctorExitCode,
  formatDoctorHuman,
  inspectInstallation,
} from "./doctor.js";
export {
  READ_TIMEOUT_MS,
  REQUIRED_COLUMNS,
  REQUIRED_TABLES,
  SQL,
  countProjectionRows,
  findThreadsFromDatabase,
  inspectRequiredSchema,
  listColumns,
  listTables,
  listThreadRowsFromDatabase,
  openReadonlyDatabase,
  readParticipantActivitiesFromDatabase,
  readThreadCycleFromDatabase,
  readThreadFromDatabase,
  readThreadWindowFromDatabase,
  retrieveLiveStateRows,
  retrieveParticipantActivityRows,
  retrieveThreadListRows,
  retrieveThreadRows,
  retrieveThreadSearchRows,
  retrieveThreadWindowRows,
  validateRequiredTables,
} from "./sqlite-store.js";
export {
  parseProviderJsonl,
  readProviderJsonl,
  PROVIDER_LABELS,
} from "./provider-jsonl.js";
export {
  installBundledSkill,
  installSkill,
  resolveSkillInstallTarget,
  resolveSkillDestination,
  bundledSkillRoot,
  resolveBundledSkillRoot,
  validateBundledSkill,
  SkillInstallationError,
  SKILL_FILES,
  SKILL_NAME,
} from "./skill-install.js";
export {
  BUNDLED_SCHEMAS,
  formatBundledSchema,
  readBundledSchema,
  resolveSchemaPath,
} from "./schema.js";
