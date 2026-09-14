import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import packageMetadata from "../package.json" with { type: "json" };

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredPackageFiles = [
  "scripts/",
  "src/",
  "schemas/",
  "skills/",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "NOTICE.txt",
];
const requiredReleaseFiles = [
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "NOTICE.txt",
  "schemas/thread.v1.json",
  "schemas/error.v1.json",
  "schemas/jsonl-record.v1.json",
  "schemas/list.v1.json",
  "schemas/tail-record.v1.json",
  "schemas/participants.v1.json",
  "schemas/doctor.v1.json",
  "schemas/find.v1.json",
  "skills/t3-thread/SKILL.md",
  "skills/t3-thread/references/cli.md",
  "skills/t3-thread/references/workflows.md",
  "skills/t3-thread/agents/openai.yaml",
];

test("package metadata whitelists the runtime, schemas, skill, and notices", () => {
  assert.deepEqual(packageMetadata.files, requiredPackageFiles);
  for (const relativePath of requiredReleaseFiles) {
    assert.equal(fs.statSync(path.join(projectRoot, relativePath)).isFile(), true, relativePath);
  }
});

test("bundled JSON schemas are valid JSON with stable version identifiers", () => {
  const expectedVersions = {
    "schemas/thread.v1.json": "t3-thread.thread.v1",
    "schemas/error.v1.json": "t3-thread.error.v1",
    "schemas/jsonl-record.v1.json": "t3-thread.jsonl-record.v1",
    "schemas/list.v1.json": "t3-thread.list.v1",
    "schemas/tail-record.v1.json": "t3-thread.tail-record.v1",
    "schemas/participants.v1.json": "t3-thread.participants.v1",
    "schemas/doctor.v1.json": "t3-thread.doctor.v1",
    "schemas/find.v1.json": "t3-thread.find.v1",
  };

  for (const [relativePath, version] of Object.entries(expectedVersions)) {
    const schema = JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), "utf8"));
    assert.equal(schema.properties.schemaVersion.const, version);
  }
});
