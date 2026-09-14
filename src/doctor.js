import fs from "node:fs";
import path from "node:path";

import {
  REQUIRED_COLUMNS,
  REQUIRED_TABLES,
  countProjectionRows,
  inspectRequiredSchema,
  openReadonlyDatabase,
} from "./sqlite-store.js";

export const DOCTOR_SCHEMA_VERSION = "t3-thread.doctor.v1";

function inspectPath(targetPath, type) {
  let exists = false;
  let isExpectedType = false;
  let readable = false;
  let error = null;

  try {
    const stats = fs.statSync(targetPath);
    exists = true;
    isExpectedType = type === "directory" ? stats.isDirectory() : stats.isFile();
    readable = isExpectedType && fs.accessSync(targetPath, fs.constants.R_OK) === undefined;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  return { path: targetPath, exists, isExpectedType, readable, error };
}

function unavailableSchema() {
  return {
    valid: false,
    requiredTables: [...REQUIRED_TABLES],
    presentTables: [],
    missingTables: [...REQUIRED_TABLES],
    requiredColumns: REQUIRED_COLUMNS,
    presentColumns: {},
    missingColumns: {},
  };
}

function databaseErrorDetails(error) {
  return error instanceof Error
    ? { code: error.code || "DATABASE_UNAVAILABLE", message: error.message }
    : { code: "DATABASE_UNAVAILABLE", message: String(error) };
}

export function inspectInstallation({ config, toolVersion }) {
  const databasePath = config.stateDb;
  const walPath = `${databasePath}-wal`;
  const home = inspectPath(config.home, "directory");
  const database = inspectPath(databasePath, "file");
  const wal = inspectPath(walPath, "file");
  const providerLogs = inspectPath(config.providerLogDirectory, "directory");

  let databaseReadable = false;
  let schema = unavailableSchema();
  let counts = null;
  let databaseError = database.error ? { code: "DATABASE_UNAVAILABLE", message: database.error } : null;
  let connection;

  try {
    connection = openReadonlyDatabase(databasePath);
    databaseReadable = true;
    schema = inspectRequiredSchema(connection);
    if (schema.valid) {
      counts = countProjectionRows(connection);
    }
    databaseError = null;
  } catch (error) {
    databaseError = databaseErrorDetails(error);
  } finally {
    connection?.close();
  }

  const healthy = databaseReadable && schema.valid && counts !== null;
  return {
    schemaVersion: DOCTOR_SCHEMA_VERSION,
    toolVersion,
    packageVersion: toolVersion,
    runtimeVersion: process.version,
    resolvedHome: home.path,
    home,
    databasePath,
    databaseReadable,
    database,
    walPath,
    walPresent: wal.exists && wal.isExpectedType,
    wal,
    schema,
    requiredTables: schema.requiredTables,
    requiredColumns: schema.requiredColumns,
    schemaValid: schema.valid,
    counts,
    providerLogDirectory: providerLogs.path,
    providerLogDirectoryPresent: providerLogs.exists && providerLogs.isExpectedType,
    providerLogs,
    healthy,
    status: healthy ? "ok" : "error",
    databaseError,
  };
}

export function formatDoctorHuman(report) {
  const yesNo = (value) => value ? "yes" : "no";
  const lines = [
    "T3 Thread Doctor",
    "=================",
    "",
    `Status: ${report.status}`,
    `Package version: ${report.packageVersion}`,
    `Runtime version: ${report.runtimeVersion}`,
    `Resolved home: ${report.resolvedHome}`,
    `Home present: ${yesNo(report.home.exists && report.home.isExpectedType)}`,
    `Home readable: ${yesNo(report.home.readable)}`,
    `Database path: ${report.databasePath}`,
    `Database readable: ${yesNo(report.databaseReadable)}`,
    `WAL present: ${yesNo(report.walPresent)}`,
    `Schema valid: ${yesNo(report.schemaValid)}`,
    `Provider log directory: ${report.providerLogDirectory}`,
    `Provider log directory present: ${yesNo(report.providerLogDirectoryPresent)}`,
  ];

  if (report.counts) {
    lines.push(
      "",
      "Counts",
      "------",
      `Threads: ${report.counts.threads}`,
      `Messages: ${report.counts.messages}`,
      `Activities: ${report.counts.activities}`,
    );
  } else {
    lines.push("", "Counts", "------", "Unavailable");
  }

  lines.push("", "Required tables", "----------------");
  for (const table of report.requiredTables) {
    lines.push(`- ${table}: ${report.schema.presentTables.includes(table) ? "present" : "missing"}`);
  }

  lines.push("", "Required columns", "-----------------");
  for (const table of report.requiredTables) {
    const tablePresent = report.schema.presentTables.includes(table);
    const missing = report.schema.missingColumns?.[table] || [];
    const status = !tablePresent
      ? "table missing"
      : missing.length === 0
        ? "present"
        : `missing ${missing.join(", ")}`;
    lines.push(`- ${table}: ${status}`);
  }

  if (report.databaseError) {
    lines.push("", `Database diagnostic: ${report.databaseError.message}`);
  }

  return `${lines.join("\n")}\n`;
}

export function doctorExitCode(report) {
  return report.healthy ? 0 : 4;
}

export function doctorPaths(report) {
  return {
    home: path.normalize(report.resolvedHome),
    database: path.normalize(report.databasePath),
    wal: path.normalize(report.walPath),
    providerLogs: path.normalize(report.providerLogDirectory),
  };
}
