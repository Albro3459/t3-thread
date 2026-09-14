import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EXIT_CODES,
  ProviderLogUnavailableError,
  createT3ThreadClient,
  parseProviderJsonl,
  readProviderJsonl,
  resolveConfig,
  resolveProviderLogPath,
} from "../src/index.js";

const THREAD_ID = "sanitized-provider-thread-0001";

function createHome() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-thread-provider-"));
  return {
    directory,
    home: path.join(directory, "home"),
  };
}

function cleanup(fixture) {
  fs.rmSync(fixture.directory, { recursive: true, force: true });
}

function writeLog(fixture, content) {
  const config = resolveConfig({ home: fixture.home });
  fs.mkdirSync(config.providerLogDirectory, { recursive: true });
  const filePath = resolveProviderLogPath(config, THREAD_ID);
  fs.writeFileSync(filePath, content);
  return { config, filePath };
}

test("parses prefixed provider JSONL in source order and preserves metadata", () => {
  const result = parseProviderJsonl([
    "[time-one] CANON: {\"sequence\":1,\"kind\":\"user\"}",
    "[time-two] NTIVE: {\"sequence\":2,\"kind\":\"assistant\"}",
    "[time-three] CANON: [1,2,3]",
  ].join("\n"));

  assert.deepEqual(result.records, [
    {
      timestamp: "time-one",
      label: "CANON",
      data: { sequence: 1, kind: "user" },
    },
    {
      timestamp: "time-two",
      label: "NTIVE",
      data: { sequence: 2, kind: "assistant" },
    },
    {
      timestamp: "time-three",
      label: "CANON",
      data: [1, 2, 3],
    },
  ]);
  assert.deepEqual(result.warnings, []);
});

test("retains parsed records and emits structured warnings for malformed lines", () => {
  const result = parseProviderJsonl([
    "[first] CANON: {\"ok\":true}",
    "not a provider record",
    "[third] NTIVE: {not-json}",
    "[fourth] OTHER: {\"ignored\":true}",
    "[fifth] CANON: {\"ok\":false}",
  ].join("\n"), { path: "/tmp/sanitized-provider.log" });

  assert.deepEqual(result.records, [
    { timestamp: "first", label: "CANON", data: { ok: true } },
    { timestamp: "fifth", label: "CANON", data: { ok: false } },
  ]);
  assert.equal(result.warnings.length, 3);
  assert.deepEqual(result.warnings.map((warning) => warning.line), [2, 3, 4]);
  assert.ok(result.warnings.every((warning) => warning.code === "MALFORMED_PROVIDER_JSONL_LINE"));
  assert.equal(result.warnings[1].details.reason, "invalid-json");
  assert.equal(result.warnings[2].details.reason, "unsupported-label");
});

test("readRawJsonl resolves the exact provider log and keeps malformed lines out of records", async () => {
  const fixture = createHome();
  try {
    const { filePath } = writeLog(fixture, [
      "[one] CANON: {\"value\":1}",
      "[broken] CANON: nope",
      "[two] NTIVE: {\"value\":2}",
    ].join("\n"));
    const client = await createT3ThreadClient({ home: fixture.home });
    const result = await client.readRawJsonl(THREAD_ID);

    assert.equal(result.path, filePath);
    assert.deepEqual(result.records.map(({ timestamp, label, data }) => ({ timestamp, label, data })), [
      { timestamp: "one", label: "CANON", data: { value: 1 } },
      { timestamp: "two", label: "NTIVE", data: { value: 2 } },
    ]);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].line, 2);

    const alternatePath = path.join(fixture.directory, "outside-provider.log");
    fs.writeFileSync(alternatePath, "[alternate] CANON: {\"value\":999}\n");
    const overrideAttempt = await client.readRawJsonl(THREAD_ID, {
      providerLogPath: alternatePath,
      providerLog: alternatePath,
      logPath: alternatePath,
    });
    assert.equal(overrideAttempt.path, filePath);
    assert.deepEqual(overrideAttempt.records.map((record) => record.data), [
      { value: 1 },
      { value: 2 },
    ]);
  } finally {
    cleanup(fixture);
  }
});

test("distinguishes missing and unreadable provider logs without discovery", async () => {
  const missingFixture = createHome();
  try {
    const client = await createT3ThreadClient({ home: missingFixture.home });
    await assert.rejects(
      () => client.readRawJsonl(THREAD_ID),
      (error) => error instanceof ProviderLogUnavailableError
        && error.code === "PROVIDER_LOG_MISSING"
        && error.details.reason === "missing"
        && error.details.path === resolveProviderLogPath(client.config, THREAD_ID)
        && error.exitCode === EXIT_CODES.DATABASE_UNAVAILABLE,
    );
  } finally {
    cleanup(missingFixture);
  }

  const unreadableFixture = createHome();
  try {
    const { filePath } = writeLog(unreadableFixture, "");
    fs.unlinkSync(filePath);
    fs.mkdirSync(filePath);
    const client = await createT3ThreadClient({ home: unreadableFixture.home });
    await assert.rejects(
      () => client.readRawJsonl(THREAD_ID),
      (error) => error instanceof ProviderLogUnavailableError
        && error.code === "PROVIDER_LOG_UNREADABLE"
        && error.details.reason === "unreadable",
    );
  } finally {
    cleanup(unreadableFixture);
  }

  const directFixture = createHome();
  try {
    const filePath = path.join(directFixture.directory, "sanitized.log");
    fs.writeFileSync(filePath, "[direct] CANON: {\"ok\":true}\n");
    const result = readProviderJsonl(filePath, { threadId: THREAD_ID });
    assert.equal(result.path, filePath);
    assert.equal(result.records[0].data.ok, true);
  } finally {
    cleanup(directFixture);
  }
});
