import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigurationError, T3ThreadError } from "./errors.js";

export const SKILL_NAME = "t3-thread";
export const SKILL_FILES = Object.freeze([
  "SKILL.md",
  "references/cli.md",
  "references/workflows.md",
  "agents/openai.yaml",
]);

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLED_SKILL_ROOT = path.join(PACKAGE_ROOT, "skills", SKILL_NAME);

export class SkillInstallationError extends T3ThreadError {
  constructor(message, details = {}, cause) {
    super(message, {
      code: "SKILL_INSTALL_FAILED",
      exitCode: 3,
      details,
      cause,
    });
    this.name = "SkillInstallationError";
  }
}

function pathIsInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveHomeDirectory(homeDirectory = os.homedir()) {
  if (typeof homeDirectory !== "string" || homeDirectory.trim() === "") {
    throw new ConfigurationError("homeDirectory must be a non-empty path.", {
      field: "homeDirectory",
    });
  }

  return path.resolve(homeDirectory);
}

export function resolveSkillInstallTarget(agent, {
  homeDirectory = os.homedir(),
  env = process.env,
} = {}) {
  const home = resolveHomeDirectory(homeDirectory);
  let skillsRoot;

  if (agent === "claude") {
    skillsRoot = path.join(home, ".claude", "skills");
  } else if (agent === "codex") {
    const codexHome = env.CODEX_HOME === undefined || env.CODEX_HOME === ""
      ? path.join(home, ".codex")
      : path.resolve(env.CODEX_HOME);
    skillsRoot = path.join(codexHome, "skills");
  } else {
    throw new ConfigurationError("Skill target must be claude or codex.", {
      field: "agent",
      value: agent,
    });
  }

  const destination = path.join(skillsRoot, SKILL_NAME);
  if (!pathIsInside(skillsRoot, destination) || path.basename(destination) !== SKILL_NAME) {
    throw new SkillInstallationError("Resolved skill destination is outside the selected skills directory.", {
      agent,
      skillsRoot,
      destination,
    });
  }

  return Object.freeze({
    agent,
    skillsRoot,
    destination,
  });
}

export function bundledSkillRoot() {
  return BUNDLED_SKILL_ROOT;
}

function ensureRegularFile(filePath, details) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw new SkillInstallationError("A bundled skill file is missing.", {
      ...details,
      path: filePath,
      reason: error?.code === "ENOENT" ? "missing" : "unreadable",
    }, error);
  }

  if (!stat.isFile()) {
    throw new SkillInstallationError("A bundled skill entry is not a regular file.", {
      ...details,
      path: filePath,
      reason: stat.isSymbolicLink() ? "symlink" : "not-file",
    });
  }
}

export function validateBundledSkill(sourceRoot = BUNDLED_SKILL_ROOT) {
  if (typeof sourceRoot !== "string" || sourceRoot.trim() === "") {
    throw new SkillInstallationError("Bundled skill source must be a non-empty path.", {
      field: "sourceRoot",
    });
  }

  const resolvedSourceRoot = path.resolve(sourceRoot);
  let stat;
  try {
    stat = fs.lstatSync(resolvedSourceRoot);
  } catch (error) {
    throw new SkillInstallationError("Bundled skill source was not found.", {
      sourceRoot: resolvedSourceRoot,
      reason: error?.code === "ENOENT" ? "missing" : "unreadable",
    }, error);
  }

  if (!stat.isDirectory()) {
    throw new SkillInstallationError("Bundled skill source must be a directory.", {
      sourceRoot: resolvedSourceRoot,
    });
  }

  for (const relativePath of SKILL_FILES) {
    ensureRegularFile(path.join(resolvedSourceRoot, relativePath), {
      sourceRoot: resolvedSourceRoot,
      relativePath,
    });
  }

  return resolvedSourceRoot;
}

function makeBackupPath(destination, now, randomBytes) {
  const stamp = new Date(now()).toISOString().replace(/[:.]/gu, "-");
  const suffix = randomBytes(4).toString("hex");
  return path.join(path.dirname(destination), `.${SKILL_NAME}.backup-${stamp}-${suffix}`);
}

function makeTemporaryPath(destination, randomBytes) {
  return path.join(
    path.dirname(destination),
    `.${SKILL_NAME}.install-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
}

function copyBundledSkill(sourceRoot, destination) {
  for (const relativePath of SKILL_FILES) {
    const sourcePath = path.join(sourceRoot, relativePath);
    const destinationPath = path.join(destination, relativePath);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
  }
}

function existingPath(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function assertNoSymlinkedSkillParent(skillsRoot, details) {
  const parentRoot = path.dirname(skillsRoot);
  let current = skillsRoot;

  while (true) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new SkillInstallationError(
          "The selected skills directory or its parent is a symbolic link; refusing to write through it.",
          {
            ...details,
            path: current,
            reason: "symlink",
          },
        );
      }
    } catch (error) {
      if (error instanceof T3ThreadError) throw error;
      if (error?.code !== "ENOENT") throw error;
    }

    if (current === parentRoot) break;
    current = path.dirname(current);
  }
}

export function installBundledSkill(agent, {
  homeDirectory = os.homedir(),
  env = process.env,
  sourceRoot = BUNDLED_SKILL_ROOT,
  overwrite = false,
  backup = false,
  now = Date.now,
  randomBytes = crypto.randomBytes,
} = {}) {
  const source = validateBundledSkill(sourceRoot);
  const target = resolveSkillInstallTarget(agent, { homeDirectory, env });
  const destination = target.destination;
  const parent = path.dirname(destination);
  assertNoSymlinkedSkillParent(target.skillsRoot, {
    agent,
    skillsRoot: target.skillsRoot,
    destination,
  });
  if (!pathIsInside(target.skillsRoot, destination)) {
    throw new SkillInstallationError("Skill installation target escaped the selected skills directory.", {
      agent,
      skillsRoot: target.skillsRoot,
      destination,
    });
  }

  fs.mkdirSync(parent, { recursive: true });
  const destinationExists = existingPath(destination);
  if (destinationExists && !overwrite && !backup) {
    throw new SkillInstallationError(
      "The destination already exists; pass --overwrite or --backup to replace it.",
      {
        agent,
        destination,
        overwriteRequired: true,
      },
    );
  }

  const temporary = makeTemporaryPath(destination, randomBytes);
  let backupPath = null;
  try {
    fs.mkdirSync(temporary);
    copyBundledSkill(source, temporary);

    if (destinationExists) {
      if (backup) {
        backupPath = makeBackupPath(destination, now, randomBytes);
        if (existingPath(backupPath)) {
          throw new SkillInstallationError("Could not create a unique skill backup path.", {
            destination,
            backupPath,
          });
        }
        fs.renameSync(destination, backupPath);
      } else {
        fs.rmSync(destination, { recursive: true, force: true });
      }
    }

    fs.renameSync(temporary, destination);
  } catch (error) {
    if (existingPath(temporary)) {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
    if (backupPath && !existingPath(destination) && existingPath(backupPath)) {
      fs.renameSync(backupPath, destination);
    }
    if (error instanceof T3ThreadError) throw error;
    throw new SkillInstallationError("Unable to install the bundled skill.", {
      agent,
      source,
      destination,
      backupPath,
    }, error);
  }

  return Object.freeze({
    agent,
    source,
    destination,
    backupPath,
    packageReadme: path.join(PACKAGE_ROOT, "README.md"),
    replaced: destinationExists,
  });
}

export const resolveBundledSkillRoot = bundledSkillRoot;
export const resolveSkillDestination = resolveSkillInstallTarget;
export const installSkill = installBundledSkill;
