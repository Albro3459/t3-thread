import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BUNDLED_SCHEMAS,
  ConfigurationError,
  SkillInstallationError,
  bundledSkillRoot,
  formatBundledSchema,
  installBundledSkill,
  readBundledSchema,
  resolveSkillInstallTarget,
  validateBundledSkill,
} from "../src/index.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(projectRoot, "scripts", "t3-thread.js");

function temporaryDirectory(prefix = "t3-thread-phase6-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

test("resolves isolated Claude and Codex skill destinations", () => {
  const home = temporaryDirectory();
  const codexHome = temporaryDirectory();
  try {
    assert.equal(
      resolveSkillInstallTarget("claude", { homeDirectory: home }).destination,
      path.join(home, ".claude", "skills", "t3-thread"),
    );
    assert.equal(
      resolveSkillInstallTarget("codex", { homeDirectory: home, env: {} }).destination,
      path.join(home, ".codex", "skills", "t3-thread"),
    );
    assert.equal(
      resolveSkillInstallTarget("codex", { homeDirectory: home, env: { CODEX_HOME: codexHome } }).destination,
      path.join(codexHome, "skills", "t3-thread"),
    );
    assert.throws(() => resolveSkillInstallTarget("other", { homeDirectory: home }), ConfigurationError);
  } finally {
    cleanup(home);
    cleanup(codexHome);
  }
});

test("validates the complete bundled source and rejects missing entries", () => {
  assert.equal(validateBundledSkill(bundledSkillRoot()), bundledSkillRoot());

  const source = temporaryDirectory();
  try {
    fs.writeFileSync(path.join(source, "SKILL.md"), "sanitized skill\n");
    assert.throws(
      () => validateBundledSkill(source),
      (error) => error instanceof SkillInstallationError && error.details.relativePath === "references/cli.md",
    );
  } finally {
    cleanup(source);
  }
});

test("refuses to replace an existing user-edited skill without an explicit policy", () => {
  const home = temporaryDirectory();
  const destination = resolveSkillInstallTarget("claude", { homeDirectory: home }).destination;
  fs.mkdirSync(destination, { recursive: true });
  const editedFile = path.join(destination, "user-edited.md");
  fs.writeFileSync(editedFile, "keep this file\n");

  try {
    assert.throws(
      () => installBundledSkill("claude", { homeDirectory: home }),
      (error) => error instanceof SkillInstallationError && error.details.overwriteRequired === true,
    );
    assert.equal(fs.readFileSync(editedFile, "utf8"), "keep this file\n");
  } finally {
    cleanup(home);
  }
});

test("installs into a temporary Claude destination and supports overwrite", () => {
  const home = temporaryDirectory();
  const destination = resolveSkillInstallTarget("claude", { homeDirectory: home }).destination;
  try {
    const created = installBundledSkill("claude", { homeDirectory: home });
    assert.equal(created.replaced, false);
    assert.equal(created.backupPath, null);
    assert.equal(fs.readFileSync(path.join(destination, "SKILL.md"), "utf8"), fs.readFileSync(path.join(bundledSkillRoot(), "SKILL.md"), "utf8"));
    assert.ok(fs.existsSync(path.join(destination, "references", "cli.md")));
    assert.ok(fs.existsSync(path.join(destination, "references", "workflows.md")));
    assert.ok(fs.existsSync(path.join(destination, "agents", "openai.yaml")));

    fs.writeFileSync(path.join(destination, "SKILL.md"), "edited content\n");
    const overwritten = installBundledSkill("claude", { homeDirectory: home, overwrite: true });
    assert.equal(overwritten.replaced, true);
    assert.notEqual(fs.readFileSync(path.join(destination, "SKILL.md"), "utf8"), "edited content\n");
  } finally {
    cleanup(home);
  }
});

test("backs up an existing Codex skill before replacement", () => {
  const home = temporaryDirectory();
  const codexHome = path.join(home, "codex-home");
  const destination = resolveSkillInstallTarget("codex", {
    homeDirectory: home,
    env: { CODEX_HOME: codexHome },
  }).destination;
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "custom.md"), "user content\n");

  try {
    const result = installBundledSkill("codex", {
      homeDirectory: home,
      env: { CODEX_HOME: codexHome },
      backup: true,
      now: () => Date.parse("2026-08-10T12:00:00.000Z"),
      randomBytes: () => Buffer.from([1, 2, 3, 4]),
    });
    assert.equal(result.replaced, true);
    assert.ok(result.backupPath);
    assert.equal(fs.readFileSync(path.join(result.backupPath, "custom.md"), "utf8"), "user content\n");
    assert.ok(fs.existsSync(path.join(destination, "SKILL.md")));
  } finally {
    cleanup(home);
  }
});

test("replaces a destination symlink without writing through it", () => {
  const home = temporaryDirectory();
  const outside = temporaryDirectory();
  const destination = resolveSkillInstallTarget("claude", { homeDirectory: home }).destination;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(path.join(outside, "sentinel.txt"), "outside\n");
  fs.symlinkSync(outside, destination, "dir");

  try {
    installBundledSkill("claude", { homeDirectory: home, overwrite: true });
    assert.equal(fs.readFileSync(path.join(outside, "sentinel.txt"), "utf8"), "outside\n");
    assert.equal(fs.lstatSync(destination).isDirectory(), true);
    assert.equal(fs.existsSync(path.join(destination, "SKILL.md")), true);
  } finally {
    cleanup(home);
    cleanup(outside);
  }
});

test("rejects a symlinked skills parent before writing outside the selected root", () => {
  const home = temporaryDirectory();
  const outside = temporaryDirectory();
  const target = resolveSkillInstallTarget("claude", { homeDirectory: home });
  fs.mkdirSync(path.dirname(target.skillsRoot), { recursive: true });
  fs.symlinkSync(outside, target.skillsRoot, "dir");

  try {
    assert.throws(
      () => installBundledSkill("claude", { homeDirectory: home }),
      (error) => error instanceof SkillInstallationError
        && error.details.path === target.skillsRoot
        && error.details.reason === "symlink",
    );
    assert.equal(fs.existsSync(path.join(outside, "t3-thread")), false);
    assert.equal(fs.lstatSync(target.skillsRoot).isSymbolicLink(), true);
  } finally {
    cleanup(home);
    cleanup(outside);
  }
});

test("schema command emits bundled schemas without T3 storage", () => {
  for (const name of BUNDLED_SCHEMAS) {
    const home = temporaryDirectory("t3-thread-schema-home-");
    try {
      const result = spawnSync(process.execPath, [executable, "schema", name], {
        cwd: projectRoot,
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.deepEqual(JSON.parse(result.stdout), readBundledSchema(name));
      assert.equal(result.stdout, formatBundledSchema(name));
    } finally {
      cleanup(home);
    }
  }
});

test("CLI install writes only to an isolated selected target", () => {
  const home = temporaryDirectory("t3-thread-cli-home-");
  const result = spawnSync(process.execPath, [executable, "install", "--skills", "claude"], {
    cwd: projectRoot,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  const destination = path.join(home, ".claude", "skills", "t3-thread");
  try {
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const lines = result.stdout.trimEnd().split("\n");
    assert.deepEqual(lines, [
      "agent=claude",
      `installed-skill=${destination}`,
      `source-skill=${bundledSkillRoot()}`,
      `package-readme=${path.join(projectRoot, "README.md")}`,
      `skill-md=${destination}/SKILL.md`,
      `references=${destination}/references`,
    ]);
    assert.ok(lines.every((line) => !line.includes("\\n")));
    assert.equal(fs.existsSync(path.join(destination, "SKILL.md")), true);
    assert.equal(fs.existsSync(path.join(home, ".codex", "skills", "t3-thread")), false);
  } finally {
    cleanup(home);
  }
});
