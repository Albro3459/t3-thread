import { resolveConfig } from "./config.js";
import {
  EXIT_CODES,
  InvalidArgumentsError,
  NotImplementedError,
  RawJsonlPartiallyUnreadableError,
  UnknownCommandError,
  serializeError,
  toT3ThreadError,
} from "./errors.js";
import { doctorExitCode, formatDoctorHuman } from "./doctor.js";
import { createT3ThreadClient } from "./index.js";
import { normalizeTailOptions } from "./query-options.js";
import { installBundledSkill } from "./skill-install.js";
import { formatBundledSchema } from "./schema.js";
import {
  formatDoctorJson,
  formatFindHuman,
  formatFindJson,
  formatListHuman,
  formatListJson,
  formatListJsonl,
  formatParticipantsHuman,
  formatParticipantsJson,
  formatParticipantsJsonl,
  formatRawJsonl,
  formatThreadHuman,
  formatThreadJson,
  formatThreadJsonl,
} from "./output.js";
import { VERSION } from "./version.js";

export { VERSION };

const COMMANDS = ["list", "get", "participants", "tail", "find", "doctor", "schema", "install"];
const STORAGE_COMMANDS = new Set(["list", "get", "participants", "tail", "find", "doctor"]);
const FORMATS = new Set(["human", "json", "jsonl"]);
const TAIL_FORMATS = new Set(["jsonl", "json"]);

const LIST_FILTER_OPTIONS = [
  { key: "project", option: "--project", kind: "value" },
  { key: "since", option: "--since", kind: "value" },
  { key: "before", option: "--before", kind: "value" },
  { key: "limit", option: "--limit", kind: "value" },
  { key: "offset", option: "--offset", kind: "value" },
];
const LIST_ONLY_OPTIONS = [
  ...LIST_FILTER_OPTIONS,
  { key: "reverse", option: "--reverse", kind: "flag" },
];
const TURN_OPTIONS = [
  { key: "lastTurn", option: "--last-turn", kind: "flag" },
  { key: "turn", option: "--turn", kind: "value" },
  { key: "turnLimit", option: "--turn-limit", kind: "value" },
  { key: "turnOffset", option: "--turn-offset", kind: "value" },
];
// tail reuses the turn-window machinery for --turn-limit but has no notion of an exact
// turn or a last-turn shortcut, so every other turn-selection option is rejected.
const TAIL_REJECTED_TURN_OPTIONS = TURN_OPTIONS.filter((def) => def.key !== "turnLimit");

// participants supports --limit, --offset, and --reverse, so only the list-only filters and
// the tail-only lifecycle options are rejected; turn selection is reused wholesale.
const PARTICIPANTS_REJECTED_OPTIONS = [
  { key: "project", option: "--project", kind: "value" },
  { key: "since", option: "--since", kind: "value" },
  { key: "before", option: "--before", kind: "value" },
  { key: "once", option: "--once", kind: "flag" },
  { key: "interval", option: "--interval", kind: "value" },
  { key: "maxCycles", option: "--max-cycles", kind: "value" },
  { key: "timeout", option: "--timeout", kind: "value" },
];

function isOptionSet(options, def) {
  return def.kind === "flag" ? options[def.key] === true : options[def.key] !== undefined;
}

function rejectOptions(options, command, optionDefs) {
  for (const def of optionDefs) {
    if (isOptionSet(options, def)) {
      throw new InvalidArgumentsError(`${def.option} is not supported by ${command}.`, {
        command,
        option: def.option,
      });
    }
  }
}

function writeLine(stream, value) {
  stream.write(`${value}\n`);
}

// Mirrors doctorExitCode: the envelope is still emitted in full, but an exact --turn that
// resolved to zero turns is surfaced as a non-zero exit rather than silently looking like a
// legitimately empty turn-window page.
function turnSelectionExitCode(warnings) {
  return warnings.some((warning) => warning.code === "TURN_NOT_FOUND")
    ? EXIT_CODES.THREAD_NOT_FOUND
    : 0;
}

const NEGATIVE_NUMBER = /^-\d/;

function requireOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (value !== undefined && NEGATIVE_NUMBER.test(value)) {
    throw new InvalidArgumentsError(`${option} does not accept a negative value.`, { option, value });
  }

  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new InvalidArgumentsError(`Missing value for ${option}.`, { option });
  }

  return value;
}

export function parseCliArgs(argv = []) {
  const result = {
    command: null,
    args: [],
    home: undefined,
    db: undefined,
    format: undefined,
    title: undefined,
    project: undefined,
    since: undefined,
    before: undefined,
    limit: undefined,
    offset: undefined,
    reverse: false,
    lastTurn: false,
    turn: undefined,
    turnLimit: undefined,
    turnOffset: undefined,
    tree: false,
    rawJsonl: false,
    once: false,
    interval: undefined,
    maxCycles: undefined,
    timeout: undefined,
    help: false,
    version: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--help" || value === "-h") {
      result.help = true;
      continue;
    }

    if (value === "--version" || value === "-v") {
      result.version = true;
      continue;
    }

    if (value === "--home") {
      result.home = requireOptionValue(argv, index, "--home");
      index += 1;
      continue;
    }

    if (value === "--db") {
      result.db = requireOptionValue(argv, index, "--db");
      index += 1;
      continue;
    }

    if (value === "--format") {
      result.format = requireOptionValue(argv, index, "--format");
      index += 1;
      continue;
    }

    if (value === "--title") {
      result.title = requireOptionValue(argv, index, "--title");
      index += 1;
      continue;
    }

    if (value === "--project") {
      result.project = requireOptionValue(argv, index, "--project");
      index += 1;
      continue;
    }

    if (value === "--since") {
      result.since = requireOptionValue(argv, index, "--since");
      index += 1;
      continue;
    }

    if (value === "--before") {
      result.before = requireOptionValue(argv, index, "--before");
      index += 1;
      continue;
    }

    if (value === "--limit") {
      result.limit = requireOptionValue(argv, index, "--limit");
      index += 1;
      continue;
    }

    if (value === "--offset") {
      result.offset = requireOptionValue(argv, index, "--offset");
      index += 1;
      continue;
    }

    if (value === "--reverse") {
      result.reverse = true;
      continue;
    }

    if (value === "--last-turn") {
      result.lastTurn = true;
      continue;
    }

    if (value === "--turn") {
      result.turn = requireOptionValue(argv, index, "--turn");
      index += 1;
      continue;
    }

    if (value === "--turn-limit") {
      result.turnLimit = requireOptionValue(argv, index, "--turn-limit");
      index += 1;
      continue;
    }

    if (value === "--turn-offset") {
      result.turnOffset = requireOptionValue(argv, index, "--turn-offset");
      index += 1;
      continue;
    }

    if (value === "--tree") {
      result.tree = true;
      continue;
    }

    if (value === "--raw-jsonl") {
      result.rawJsonl = true;
      continue;
    }

    if (value === "--once") {
      result.once = true;
      continue;
    }

    if (value === "--interval") {
      result.interval = requireOptionValue(argv, index, "--interval");
      index += 1;
      continue;
    }

    if (value === "--max-cycles") {
      result.maxCycles = requireOptionValue(argv, index, "--max-cycles");
      index += 1;
      continue;
    }

    if (value === "--timeout") {
      result.timeout = requireOptionValue(argv, index, "--timeout");
      index += 1;
      continue;
    }

    if (value === "--") {
      result.args.push(...argv.slice(index + 1));
      break;
    }

    if (result.command === null) {
      if (value.startsWith("-")) {
        throw new InvalidArgumentsError(`Unknown option: ${value}`, { option: value });
      }

      result.command = value;
      continue;
    }

    result.args.push(value);
  }

  return result;
}

export function formatHelp() {
  return [
    `t3-thread ${VERSION}`,
    "",
    "Read-only access to local T3 Code conversation threads.",
    "",
    "Usage:",
    "  t3-thread [options] <command> [args]",
    "  t3-thread --help",
    "  t3-thread --version",
    "",
    "Options:",
    "  --home <path>           Use a T3 home directory",
    "  --db <path>             Override the SQLite database path",
    "  --format <format>       Use human, json, or jsonl output",
    "  -h, --help              Show this help",
    "  -v, --version           Show the package version",
    "  list and find default to oldest-first ordering; pass --reverse for newest-first.",
    "",
    "Commands:",
    "  list                    List recent threads (metadata only)",
    "    --project <text>       Match a project title, case-insensitively",
    "    --since <timestamp>    Include threads updated at or after an ISO-8601 timestamp",
    "                            (a date-time with no UTC offset is interpreted as UTC)",
    "    --before <timestamp>   Include threads updated before an ISO-8601 timestamp",
    "                            (a date-time with no UTC offset is interpreted as UTC)",
    "    --limit <n>            Maximum threads to return (default 50; must be 1 or greater)",
    "    --offset <n>           Skip matching threads before applying --limit",
    "    --reverse              Sort newest-first instead of oldest-first",
    "    --format human|json|jsonl",
    "  get <thread-id>         Retrieve one thread",
    "    --format human        Human-readable output (default)",
    "    --format json         Complete normalized thread.v1 JSON",
    "    --format jsonl        One normalized record per line",
    "    --raw-jsonl            Emit parsed raw provider events as JSONL",
    "    --last-turn            Retrieve only the newest turn and its records",
    "    --turn <turn-id>       Retrieve one exact turn and its records",
    "    --turn-limit <n>       Retrieve a bounded window of turns from the newest side (must be 1 or greater)",
    "    --turn-offset <n>      Skip turns from the newest side before --turn-limit",
    "  participants <thread-id>  List the task participants in a thread",
    "    --tree                 Nest explicit parent/child relationships",
    "    --last-turn            Only participants whose activities touch the newest turn",
    "    --turn <turn-id>       Only participants whose activities touch that turn",
    "    --turn-limit <n>       Only participants touching the newest n turns (must be 1 or greater)",
    "    --turn-offset <n>      Skip turns from the newest side before --turn-limit",
    "    --limit <n>            Maximum participants returned (no default; must be 1 or greater)",
    "    --offset <n>           Skip participants before applying --limit",
    "    --reverse              Newest-first instead of the default oldest-first",
    "    --format human|json|jsonl",
    "  tail <thread-id>        Follow a thread by polling the read-only projection",
    "    --once                 Poll once, emit the result, and exit",
    "    --interval <ms>        Poll interval in milliseconds; default 1000; 100-60000",
    "    --max-cycles <n>       Stop after n poll cycles",
    "    --timeout <ms>         Stop after a wall-clock duration",
    "    --turn-limit <n>       Bound each poll to the newest n turns (must be 1 or greater)",
    "    --format jsonl|json    jsonl is the default; json requires a bounded tail",
    "  find --title <text>     Find threads by title",
    "    --format json          Emit normalized search results",
    "    --reverse              Sort newest-first instead of oldest-first",
    "  doctor                  Check the local T3 installation",
    "    --format json          Emit machine-readable diagnostics",
    "  schema <name>           Print a bundled schema",
    "  install --skills <agent>",
    "                          Install the bundled recovery skill",
    "    --overwrite            Replace an existing skill directory",
    "    --backup               Back up an existing skill before replacing",
    "  help                    Show this help",
  ].join("\n");
}

async function handleList(options) {
  const args = options.args || [];
  if (args.length !== 0) {
    throw new InvalidArgumentsError("list does not accept positional arguments.", {
      command: "list",
      expected: "list [options]",
    });
  }

  if (options.title !== undefined) {
    throw new InvalidArgumentsError("--title is only supported by find.", {
      command: "list",
      option: "--title",
    });
  }

  if (options.rawJsonl) {
    throw new InvalidArgumentsError("--raw-jsonl is only supported by get.", {
      command: "list",
      option: "--raw-jsonl",
    });
  }

  rejectOptions(options, "list", TURN_OPTIONS);

  const format = options.format || "human";
  if (!FORMATS.has(format)) {
    throw new InvalidArgumentsError(`Unsupported output format: ${format}.`, {
      command: "list",
      format,
      supportedFormats: [...FORMATS],
    });
  }

  const config = options.config || resolveConfig(options);
  const client = await createT3ThreadClient({ home: config.home, db: config.stateDb });
  const list = await client.listThreads({
    project: options.project,
    since: options.since,
    before: options.before,
    limit: options.limit,
    offset: options.offset,
    reverse: options.reverse,
  });

  if (format === "json") {
    return { output: formatListJson(list) };
  }

  if (format === "jsonl") {
    return { output: formatListJsonl(list) };
  }

  return { output: formatListHuman(list) };
}

async function handleGet(options) {
  const args = options.args || [];
  if (options.title !== undefined) {
    throw new InvalidArgumentsError("--title is only supported by find.", {
      command: "get",
      option: "--title",
    });
  }

  rejectOptions(options, "get", LIST_ONLY_OPTIONS);

  const unknownOption = args.find((argument) => argument.startsWith("-"));
  if (unknownOption) {
    throw new InvalidArgumentsError(`Unknown option: ${unknownOption}`, {
      command: "get",
      option: unknownOption,
    });
  }

  if (args.length !== 1) {
    throw new InvalidArgumentsError("get requires exactly one thread ID.", {
      command: "get",
      expected: "<thread-id>",
    });
  }

  const format = options.format || "human";
  if (!FORMATS.has(format)) {
    throw new InvalidArgumentsError(`Unsupported output format: ${format}.`, {
      command: "get",
      format,
      supportedFormats: [...FORMATS],
    });
  }

  if (options.rawJsonl && options.format !== undefined && options.format !== "jsonl") {
    throw new InvalidArgumentsError("--raw-jsonl only supports JSONL output.", {
      command: "get",
      option: "--format",
      format: options.format,
    });
  }

  if (options.rawJsonl) {
    const turnOptionUsed = TURN_OPTIONS.find((def) => isOptionSet(options, def));
    if (turnOptionUsed) {
      throw new InvalidArgumentsError(
        "--raw-jsonl cannot be combined with turn selection options because raw provider output is not a projection window.",
        { command: "get", option: turnOptionUsed.option },
      );
    }
  }

  const config = options.config || resolveConfig(options);
  const client = await createT3ThreadClient({ home: config.home, db: config.stateDb });
  if (options.rawJsonl) {
    const raw = await client.readRawJsonl(args[0]);
    const diagnostics = raw.warnings.length === 0
      ? undefined
      : serializeError(new RawJsonlPartiallyUnreadableError(args[0], raw.path, raw.warnings));
    return {
      output: formatRawJsonl(raw.records),
      diagnostics,
      exitCode: raw.warnings.length === 0 ? 0 : 5,
    };
  }

  const thread = await client.getThread(args[0], {
    lastTurn: options.lastTurn,
    turnId: options.turn,
    turnLimit: options.turnLimit,
    turnOffset: options.turnOffset,
  });

  const exitCode = turnSelectionExitCode(thread.warnings);

  if (format === "json") {
    return { output: formatThreadJson(thread), exitCode };
  }

  if (format === "jsonl") {
    return { output: formatThreadJsonl(thread), exitCode };
  }

  return { output: formatThreadHuman(thread), exitCode };
}

async function handleParticipants(options) {
  const args = options.args || [];
  if (options.title !== undefined) {
    throw new InvalidArgumentsError("--title is only supported by find.", {
      command: "participants",
      option: "--title",
    });
  }

  if (options.rawJsonl) {
    throw new InvalidArgumentsError("--raw-jsonl is only supported by get.", {
      command: "participants",
      option: "--raw-jsonl",
    });
  }

  rejectOptions(options, "participants", PARTICIPANTS_REJECTED_OPTIONS);

  const unknownOption = args.find((argument) => argument.startsWith("-"));
  if (unknownOption) {
    throw new InvalidArgumentsError(`Unknown option: ${unknownOption}`, {
      command: "participants",
      option: unknownOption,
    });
  }

  if (args.length !== 1) {
    throw new InvalidArgumentsError("participants requires exactly one thread ID.", {
      command: "participants",
      expected: "<thread-id>",
    });
  }

  const format = options.format || "human";
  if (!FORMATS.has(format)) {
    throw new InvalidArgumentsError(`Unsupported output format: ${format}.`, {
      command: "participants",
      format,
      supportedFormats: [...FORMATS],
    });
  }

  if (options.tree && format === "jsonl") {
    throw new InvalidArgumentsError(
      "--tree cannot be combined with --format jsonl because JSONL is a flat "
        + "one-record-per-line contract and cannot express a nested tree.",
      { command: "participants", option: "--tree", format },
    );
  }

  const config = options.config || resolveConfig(options);
  const client = await createT3ThreadClient({ home: config.home, db: config.stateDb });
  const view = await client.listParticipants(args[0], {
    turnId: options.turn,
    turnLimit: options.turnLimit,
    turnOffset: options.turnOffset,
    lastTurn: options.lastTurn,
    reverse: options.reverse,
    limit: options.limit,
    offset: options.offset,
    tree: options.tree,
  });

  const exitCode = turnSelectionExitCode(view.warnings);

  if (format === "json") {
    return { output: formatParticipantsJson(view), exitCode };
  }

  if (format === "jsonl") {
    return { output: formatParticipantsJsonl(view), exitCode };
  }

  return { output: formatParticipantsHuman(view), exitCode };
}

// tail streams t3-thread.tail-record.v1 records straight to the provided stream rather
// than returning an `output` string, because the run can be unbounded and can end by
// throwing (thread-not-found, database-unavailable). Writing as records arrive, instead of
// buffering everything into a return value, is what makes SIGINT and broken-pipe handling
// possible.
async function handleTail(options) {
  const args = options.args || [];
  if (options.title !== undefined) {
    throw new InvalidArgumentsError("--title is only supported by find.", {
      command: "tail",
      option: "--title",
    });
  }

  if (options.rawJsonl) {
    throw new InvalidArgumentsError("--raw-jsonl is only supported by get.", {
      command: "tail",
      option: "--raw-jsonl",
    });
  }

  rejectOptions(options, "tail", LIST_ONLY_OPTIONS);
  rejectOptions(options, "tail", TAIL_REJECTED_TURN_OPTIONS);

  const unknownOption = args.find((argument) => argument.startsWith("-"));
  if (unknownOption) {
    throw new InvalidArgumentsError(`Unknown option: ${unknownOption}`, {
      command: "tail",
      option: unknownOption,
    });
  }

  if (args.length !== 1) {
    throw new InvalidArgumentsError("tail requires exactly one thread ID.", {
      command: "tail",
      expected: "<thread-id>",
    });
  }

  const format = options.format || "jsonl";
  if (!TAIL_FORMATS.has(format)) {
    throw new InvalidArgumentsError(`Unsupported output format for tail: ${format}.`, {
      command: "tail",
      format,
      supportedFormats: [...TAIL_FORMATS],
    });
  }

  const tailOptions = normalizeTailOptions({
    once: options.once,
    intervalMs: options.interval,
    maxCycles: options.maxCycles,
    timeoutMs: options.timeout,
    turnLimit: options.turnLimit,
  });

  if (format === "json" && !tailOptions.bounded) {
    throw new InvalidArgumentsError(
      "--format json requires --once, --max-cycles, or --timeout because an unbounded tail never finishes.",
      { command: "tail", format },
    );
  }

  const stdout = options.io?.stdout || process.stdout;
  const stderr = options.io?.stderr || process.stderr;
  const canListenStdout = typeof stdout.on === "function";

  const config = options.config || resolveConfig(options);
  const client = await createT3ThreadClient({ home: config.home, db: config.stateDb });

  const controller = new AbortController();
  let brokenPipe = false;
  function onStdoutError(error) {
    if (error?.code === "EPIPE" || error?.code === "ERR_STREAM_DESTROYED") {
      brokenPipe = true;
      controller.abort();
    }
  }
  // Left attached for the rest of the process. A failed write reports EPIPE asynchronously,
  // so detaching this when the loop ends would let the last write crash the process with an
  // unhandled error event instead of exiting quietly.
  if (canListenStdout) {
    stdout.on("error", onStdoutError);
  }

  // The EPIPE event can arrive a tick after the write that caused it, so also treat an
  // already-destroyed stream as closed rather than writing into it again.
  function writableClosed() {
    return brokenPipe || stdout.destroyed === true || stdout.writableEnded === true;
  }

  function onSigint() {
    controller.abort();
  }
  process.on("SIGINT", onSigint);

  const buffered = format === "json" ? [] : null;

  try {
    // Forward the raw values, not the normalized ones: tailThread validates again, and a
    // resolved default interval would look like an explicit --interval next to --once.
    for await (const record of client.tailThread(args[0], {
      once: options.once,
      intervalMs: options.interval,
      maxCycles: options.maxCycles,
      timeoutMs: options.timeout,
      turnLimit: options.turnLimit,
      signal: controller.signal,
      onDiagnostic: (diagnostic) => {
        if (!writableClosed()) {
          writeLine(stderr, JSON.stringify(diagnostic));
        }
      },
    })) {
      if (writableClosed()) {
        continue;
      }
      if (buffered) {
        buffered.push(record);
      } else {
        writeLine(stdout, JSON.stringify(record));
      }
    }
  } finally {
    if (buffered && !writableClosed()) {
      writeLine(stdout, JSON.stringify(buffered, null, 2));
    }
    process.off("SIGINT", onSigint);
  }

  return { exitCode: 0 };
}

async function handleFind(options) {
  const args = options.args || [];
  if (typeof options.title !== "string" || options.title.trim() === "") {
    throw new InvalidArgumentsError("find requires a non-empty title string.", {
      command: "find",
      field: "title",
    });
  }

  if (args.length !== 0) {
    throw new InvalidArgumentsError("find does not accept positional arguments.", {
      command: "find",
      expected: "--title <text>",
    });
  }

  if (options.rawJsonl) {
    throw new InvalidArgumentsError("--raw-jsonl is only supported by get.", {
      command: "find",
      option: "--raw-jsonl",
    });
  }

  rejectOptions(options, "find", [...LIST_FILTER_OPTIONS, ...TURN_OPTIONS]);

  const format = options.format || "human";
  if (format !== "human" && format !== "json") {
    throw new InvalidArgumentsError(`Unsupported output format for find: ${format}.`, {
      command: "find",
      format,
      supportedFormats: ["human", "json"],
    });
  }

  const config = options.config || resolveConfig(options);
  const client = await createT3ThreadClient({ home: config.home, db: config.stateDb });
  const matches = await client.findThreads({ title: options.title, reverse: options.reverse });

  return {
    output: format === "json"
      ? formatFindJson(matches)
      : formatFindHuman(matches),
  };
}

async function handleDoctor(options) {
  const args = options.args || [];
  if (args.length !== 0) {
    throw new InvalidArgumentsError("doctor does not accept positional arguments.", {
      command: "doctor",
      expected: "doctor",
    });
  }

  if (options.title !== undefined) {
    throw new InvalidArgumentsError("--title is only supported by find.", {
      command: "doctor",
      option: "--title",
    });
  }

  if (options.rawJsonl) {
    throw new InvalidArgumentsError("--raw-jsonl is only supported by get.", {
      command: "doctor",
      option: "--raw-jsonl",
    });
  }

  rejectOptions(options, "doctor", [...LIST_ONLY_OPTIONS, ...TURN_OPTIONS]);

  const format = options.format || "human";
  if (format !== "human" && format !== "json") {
    throw new InvalidArgumentsError(`Unsupported output format for doctor: ${format}.`, {
      command: "doctor",
      format,
      supportedFormats: ["human", "json"],
    });
  }

  const config = options.config || resolveConfig(options);
  const client = await createT3ThreadClient({ home: config.home, db: config.stateDb });
  const report = await client.doctor();
  return {
    output: format === "json" ? formatDoctorJson(report) : formatDoctorHuman(report),
    exitCode: doctorExitCode(report),
  };
}

function parseInstallOptions(args) {
  if (args[0] !== "--skills") {
    throw new InvalidArgumentsError('install requires "--skills <claude|codex>".', {
      command: "install",
      expected: "--skills <claude|codex>",
    });
  }

  const agent = args[1];
  if (agent !== "claude" && agent !== "codex") {
    throw new InvalidArgumentsError('install requires a skills target of "claude" or "codex".', {
      command: "install",
      field: "skills",
      value: agent,
    });
  }

  let overwrite = false;
  let backup = false;
  for (const argument of args.slice(2)) {
    if (argument === "--overwrite") {
      overwrite = true;
      continue;
    }
    if (argument === "--backup") {
      backup = true;
      continue;
    }

    throw new InvalidArgumentsError(`Unknown install option: ${argument}`, {
      command: "install",
      option: argument,
    });
  }

  return { agent, overwrite, backup };
}

async function handleSchema(options) {
  if (options.args.length !== 1 || options.args[0].startsWith("-")) {
    throw new InvalidArgumentsError("schema requires exactly one schema name.", {
      command: "schema",
      expected: "schema <thread.v1|error.v1|jsonl-record.v1|list.v1|tail-record.v1|participants.v1|doctor.v1|find.v1>",
    });
  }

  rejectOptions(options, "schema", [...LIST_ONLY_OPTIONS, ...TURN_OPTIONS]);

  return { output: formatBundledSchema(options.args[0]) };
}

async function handleInstall(options) {
  if (options.title !== undefined || options.rawJsonl || options.format !== undefined) {
    throw new InvalidArgumentsError("install only supports --skills, --overwrite, and --backup.", {
      command: "install",
    });
  }

  rejectOptions(options, "install", [...LIST_ONLY_OPTIONS, ...TURN_OPTIONS]);

  const installOptions = parseInstallOptions(options.args);
  const result = installBundledSkill(installOptions.agent, installOptions);
  const lines = [
    `agent=${result.agent}`,
    `installed-skill=${result.destination}`,
    `source-skill=${result.source}`,
    `package-readme=${result.packageReadme}`,
  ];
  if (result.backupPath) {
    lines.push(`backup=${result.backupPath}`);
  }
  lines.push(`skill-md=${result.destination}/SKILL.md`);
  lines.push(`references=${result.destination}/references`);
  return { output: `${lines.join("\n")}\n` };
}

async function notImplemented(options) {
  throw new NotImplementedError(options.command);
}

const commandHandlers = new Map(COMMANDS.map((command) => [command, notImplemented]));
commandHandlers.set("list", handleList);
commandHandlers.set("get", handleGet);
commandHandlers.set("participants", handleParticipants);
commandHandlers.set("tail", handleTail);
commandHandlers.set("find", handleFind);
commandHandlers.set("doctor", handleDoctor);
commandHandlers.set("schema", handleSchema);
commandHandlers.set("install", handleInstall);

export async function dispatchCommand(options) {
  if (options.command === "help") {
    return { help: true };
  }

  const handler = commandHandlers.get(options.command);
  if (!handler) {
    throw new UnknownCommandError(options.command);
  }

  return handler(options);
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  let options;

  try {
    options = parseCliArgs(argv);

    if (options.version) {
      writeLine(stdout, VERSION);
      return 0;
    }

    if (options.help || options.command === null || options.command === "help") {
      writeLine(stdout, formatHelp());
      return 0;
    }

    const config = STORAGE_COMMANDS.has(options.command) ? resolveConfig(options) : undefined;
    const result = await dispatchCommand({ ...options, config, io: { stdout, stderr } });
    if (result?.output !== undefined) {
      stdout.write(result.output);
    }
    if (result?.diagnostics !== undefined) {
      writeLine(stderr, JSON.stringify(result.diagnostics));
    }
    return result?.exitCode ?? 0;
  } catch (error) {
    const normalized = toT3ThreadError(error);
    writeLine(stderr, JSON.stringify(serializeError(normalized)));
    return normalized.exitCode;
  }
}
