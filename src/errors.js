export const ERROR_SCHEMA_VERSION = "t3-thread.error.v1";

export const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  UNEXPECTED_FAILURE: 1,
  THREAD_NOT_FOUND: 2,
  INVALID_ARGUMENTS: 3,
  DATABASE_UNAVAILABLE: 4,
  RAW_JSONL_PARTIALLY_UNREADABLE: 5,
});

export class T3ThreadError extends Error {
  constructor(message, { code = "T3_THREAD_ERROR", exitCode = EXIT_CODES.UNEXPECTED_FAILURE, details = {}, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "T3ThreadError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }

  toJSON() {
    return serializeError(this);
  }
}

export class ConfigurationError extends T3ThreadError {
  constructor(message, details = {}) {
    super(message, {
      code: "INVALID_CONFIGURATION",
      exitCode: EXIT_CODES.INVALID_ARGUMENTS,
      details,
    });
    this.name = "ConfigurationError";
  }
}

export class InvalidArgumentsError extends T3ThreadError {
  constructor(message, details = {}) {
    super(message, {
      code: "INVALID_ARGUMENTS",
      exitCode: EXIT_CODES.INVALID_ARGUMENTS,
      details,
    });
    this.name = "InvalidArgumentsError";
  }
}

export class UnknownCommandError extends InvalidArgumentsError {
  constructor(command) {
    super(`Unknown command: ${command}`, { command });
    this.name = "UnknownCommandError";
    this.code = "UNKNOWN_COMMAND";
  }
}

export class ThreadNotFoundError extends T3ThreadError {
  constructor(threadId) {
    super("No thread matched the supplied ID.", {
      code: "THREAD_NOT_FOUND",
      exitCode: EXIT_CODES.THREAD_NOT_FOUND,
      details: { threadId },
    });
    this.name = "ThreadNotFoundError";
  }
}

export class DatabaseUnavailableError extends T3ThreadError {
  constructor(message, details = {}, cause) {
    super(message, {
      code: "DATABASE_UNAVAILABLE",
      exitCode: EXIT_CODES.DATABASE_UNAVAILABLE,
      details,
      cause,
    });
    this.name = "DatabaseUnavailableError";
  }
}

export class ProviderLogUnavailableError extends T3ThreadError {
  constructor(threadId, filePath, reason, cause) {
    const missing = reason === "missing";
    super(missing ? "The provider log does not exist." : "The provider log is not readable.", {
      code: missing ? "PROVIDER_LOG_MISSING" : "PROVIDER_LOG_UNREADABLE",
      exitCode: EXIT_CODES.DATABASE_UNAVAILABLE,
      details: {
        threadId,
        path: filePath,
        reason,
        error: cause instanceof Error ? cause.message : String(cause),
      },
      cause,
    });
    this.name = "ProviderLogUnavailableError";
  }
}

export class RawJsonlPartiallyUnreadableError extends T3ThreadError {
  constructor(threadId, filePath, warnings) {
    super("The provider JSONL contains unreadable records.", {
      code: "RAW_JSONL_PARTIALLY_UNREADABLE",
      exitCode: EXIT_CODES.RAW_JSONL_PARTIALLY_UNREADABLE,
      details: {
        threadId,
        path: filePath,
        warnings,
      },
    });
    this.name = "RawJsonlPartiallyUnreadableError";
  }
}

export class SchemaUnavailableError extends DatabaseUnavailableError {
  constructor(missingTables = [], details = {}) {
    const missingColumns = details.missingColumns || {};
    const missingDescription = missingTables.length > 0
      ? "required projection tables"
      : "required projection columns";
    super(`The SQLite database is missing ${missingDescription}.`, {
      ...details,
      missingTables,
      missingColumns,
    });
    this.name = "SchemaUnavailableError";
    this.code = "SCHEMA_UNAVAILABLE";
  }
}

export class NotImplementedError extends T3ThreadError {
  constructor(command) {
    super(`The \"${command}\" command is not implemented yet.`, {
      code: "NOT_IMPLEMENTED",
      exitCode: EXIT_CODES.UNEXPECTED_FAILURE,
      details: { command },
    });
    this.name = "NotImplementedError";
  }
}

export function isT3ThreadError(error) {
  return error instanceof T3ThreadError;
}

export function toT3ThreadError(error) {
  if (isT3ThreadError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return new T3ThreadError(error.message, { cause: error });
  }

  return new T3ThreadError(String(error));
}

export function serializeError(error) {
  const normalized = toT3ThreadError(error);
  return {
    schemaVersion: ERROR_SCHEMA_VERSION,
    code: normalized.code,
    message: normalized.message,
    details: normalized.details,
  };
}
