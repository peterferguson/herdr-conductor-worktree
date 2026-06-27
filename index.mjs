#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const TAG = "[conductor-worktree]";
const SUPPORTED_CONDUCTOR_BASELINES = [
  { appVersion: "0.69.1", migrationMax: 113 },
  { appVersion: "0.70.0", migrationMax: 114 },
];
const DEFAULT_SESSION_MODEL = "opus-4-8-1m";

function log(message) {
  process.stdout.write(`${TAG} ${message}\n`);
}

function die(message) {
  process.stderr.write(`${TAG} error: ${message}\n`);
  process.exit(1);
}

export function slugify(value) {
  const slug = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug || "workspace";
}

export function timestampSlug(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("");
  const time = [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join("");
  return `herdr-test-${stamp}-${time}`;
}

export function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function parseBranchPrefix(settingsToml) {
  const match = settingsToml.match(/^\s*branch_prefix\s*=\s*"([^"]*)"\s*$/m);
  return match ? match[1] : "";
}

export function readConductorBranchPrefix(settingsPath = join(homedir(), ".conductor", "settings.toml")) {
  if (!existsSync(settingsPath)) return "";
  return parseBranchPrefix(readFileSync(settingsPath, "utf8"));
}

export function conductorPath(repoRoot, workspaceSlug, conductorRoot = "~/conductor/workspaces") {
  return resolve(expandHome(conductorRoot), basename(repoRoot), workspaceSlug);
}

export function parseArgs(argv) {
  const args = {
    command: argv[0],
    cwd: undefined,
    workspaceId: undefined,
    branch: undefined,
    slug: undefined,
    conductorRoot: process.env.CONDUCTOR_WORKTREE_ROOT || "~/conductor/workspaces",
    conductorApp: process.env.CONDUCTOR_APP_PATH || "/Applications/Conductor.app",
    conductorDb: process.env.CONDUCTOR_DB_PATH || defaultConductorDbPath(),
    repoId: undefined,
    sessionModel: process.env.CONDUCTOR_WORKTREE_SESSION_MODEL || DEFAULT_SESSION_MODEL,
    dryRun: false,
    registerConductor: false,
    restartConductor: false,
    interactive: false,
    openNew: false,
    removeArchived: false,
    unsafeConductorVersion: false,
    force: false,
  };

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--cwd") {
      args.cwd = argv[++i];
    } else if (arg === "--workspace-id") {
      args.workspaceId = argv[++i];
    } else if (arg === "--branch") {
      args.branch = argv[++i];
    } else if (arg === "--slug") {
      args.slug = argv[++i];
    } else if (arg === "--conductor-root") {
      args.conductorRoot = argv[++i];
    } else if (arg === "--conductor-app") {
      args.conductorApp = argv[++i];
    } else if (arg === "--conductor-db") {
      args.conductorDb = argv[++i];
    } else if (arg === "--repo-id") {
      args.repoId = argv[++i];
    } else if (arg === "--session-model") {
      args.sessionModel = argv[++i];
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--register-conductor") {
      args.registerConductor = true;
    } else if (arg === "--restart-conductor") {
      args.restartConductor = true;
    } else if (arg === "--interactive") {
      args.interactive = true;
    } else if (arg === "--open-new") {
      args.openNew = true;
    } else if (arg === "--remove-archived") {
      args.removeArchived = true;
    } else if (arg === "--unsafe-conductor-version") {
      args.unsafeConductorVersion = true;
    } else if (arg === "--force") {
      args.force = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (args.command === "create") {
    return args;
  }
  if (args.command === "archive") {
    if (!args.workspaceId && !args.cwd && !args.branch) {
      throw new Error("archive requires one of --workspace-id, --cwd, or --branch");
    }
    return args;
  }
  if (args.command === "sync-from-conductor") {
    return args;
  }
  throw new Error(
    [
      "usage:",
      "  index.mjs create [--cwd PATH] [--slug NAME] [--conductor-root PATH] [--dry-run] [--register-conductor] [--restart-conductor]",
      "  index.mjs archive (--workspace-id ID | --cwd PATH | --branch NAME) [--force] [--restart-conductor]",
      "  index.mjs sync-from-conductor [--interactive] [--open-new] [--remove-archived] [--dry-run]",
    ].join("\n"),
  );
}

function pluginContext() {
  try {
    return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  } catch {
    return {};
  }
}

function sourceCwd(explicitCwd) {
  if (explicitCwd) return explicitCwd;
  const ctx = pluginContext();
  return ctx.focused_pane_cwd || ctx.workspace_cwd || process.cwd();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout,
  });
  if (result.error || result.status === null) {
    return {
      ok: false,
      out: result.stdout?.trim() || "",
      err: result.error?.message || result.stderr?.trim() || "process failed",
      status: result.status,
    };
  }
  return {
    ok: result.status === 0,
    out: result.stdout.trim(),
    err: result.stderr.trim(),
    status: result.status,
  };
}

function git(cwd, ...args) {
  return run("git", ["-C", cwd, ...args]);
}

function repoRoot(cwd) {
  const result = git(cwd, "rev-parse", "--show-toplevel");
  if (!result.ok || !result.out) {
    die(`${cwd} is not inside a Git repository`);
  }
  return result.out;
}

function branchExists(repo, branch) {
  return git(repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`).ok;
}

function worktreeIsClean(worktreePath) {
  const result = git(worktreePath, "status", "--porcelain");
  return result.ok && result.out === "";
}

function herdrBin() {
  return process.env.HERDR_BIN_PATH || "herdr";
}

function createWorktree({ repo, slug, branch, targetPath, dryRun }) {
  const command = [
    "worktree",
    "create",
    "--cwd",
    repo,
    "--branch",
    branch,
    "--path",
    targetPath,
    "--label",
    slug,
    "--focus",
    "--json",
  ];

  if (dryRun) {
    log(`dry-run: ${herdrBin()} ${command.map((part) => JSON.stringify(part)).join(" ")}`);
    return;
  }

  const result = run(herdrBin(), command);
  if (!result.ok) {
    die(result.err || result.out || `herdr ${command.join(" ")} failed`);
  }

  if (result.out) {
    process.stdout.write(`${result.out}\n`);
  }
}

export function defaultConductorDbPath() {
  return join(homedir(), "Library", "Application Support", "com.conductor.app", "conductor.db");
}

function conductorSupportDir(dbPath) {
  return dirname(dbPath);
}

function backupDirForDb(dbPath) {
  return join(conductorSupportDir(dbPath), "backups", "herdr-conductor-worktree");
}

export function parseConductorVersion(output) {
  return String(output).trim();
}

function readConductorAppVersion(appPath) {
  const plistPath = join(appPath, "Contents", "Info.plist");
  const result = run("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plistPath]);
  if (!result.ok) {
    die(`could not read Conductor version from ${plistPath}: ${result.err || result.out}`);
  }
  return parseConductorVersion(result.out);
}

function sqlite(dbPath, sql, options = {}) {
  const args = [];
  if (options.json) args.push("-json");
  if (options.header) args.push("-header");
  args.push(dbPath, sql);
  const result = run("sqlite3", args);
  if (!result.ok) {
    die(`sqlite3 failed for ${dbPath}: ${result.err || result.out}`);
  }
  return result.out;
}

function sqliteJson(dbPath, sql) {
  const out = sqlite(dbPath, sql, { json: true });
  if (!out) return [];
  try {
    return JSON.parse(out);
  } catch (error) {
    die(`sqlite3 returned invalid JSON: ${error.message}`);
  }
}

function readMigrationWatermark(dbPath) {
  const rows = sqliteJson(
    dbPath,
    "select max(version) as max_version, count(*) as migration_count from _sqlx_migrations;",
  );
  const row = rows[0] || {};
  return {
    maxVersion: Number(row.max_version),
    count: Number(row.migration_count),
  };
}

export function assertConductorCompatibility({ appVersion, migrationMax, unsafe }) {
  if (unsafe) return;
  const supported = SUPPORTED_CONDUCTOR_BASELINES.some(
    (baseline) => baseline.appVersion === appVersion && baseline.migrationMax === migrationMax,
  );
  if (!supported) {
    throw new Error(
      [
        `unsupported Conductor state: app ${appVersion || "unknown"}, migration ${migrationMax || "unknown"}`,
        `supported baselines are ${formatSupportedBaselines()}`,
        "pass --unsafe-conductor-version only after updating the schema snapshot and accepting the risk",
      ].join("; "),
    );
  }
}

function formatSupportedBaselines() {
  return SUPPORTED_CONDUCTOR_BASELINES.map(
    (baseline) => `app ${baseline.appVersion}, migration ${baseline.migrationMax}`,
  ).join(" or ");
}

export function parseConductorSettings(rows) {
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return {
    clientInstanceId: values.client_instance_id || "",
    branchPrefixType: values.branch_prefix_type || "",
    branchPrefixCustom: values.branch_prefix_custom || "",
    deleteBranchOnArchive: parseBooleanSetting(values.delete_branch_on_archive),
  };
}

function parseBooleanSetting(value) {
  if (value === true || value === 1) return true;
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function readConductorSettings(dbPath) {
  return parseConductorSettings(
    sqliteJson(
      dbPath,
      [
        "select key, value from settings where key in (",
        "'client_instance_id',",
        "'branch_prefix_type',",
        "'branch_prefix_custom',",
        "'delete_branch_on_archive'",
        ");",
      ].join(""),
    ),
  );
}

function conductorBranchPrefix(settings) {
  if (settings.branchPrefixType === "custom") return settings.branchPrefixCustom || "";
  return "";
}

function loadConductorEnvironment(args) {
  const dbPath = resolve(expandHome(args.conductorDb));
  if (!existsSync(dbPath)) {
    die(`Conductor DB not found: ${dbPath}`);
  }
  const appVersion = readConductorAppVersion(resolve(expandHome(args.conductorApp)));
  const migration = readMigrationWatermark(dbPath);
  try {
    assertConductorCompatibility({
      appVersion,
      migrationMax: migration.maxVersion,
      unsafe: args.unsafeConductorVersion,
    });
  } catch (error) {
    die(error.message);
  }

  const settings = readConductorSettings(dbPath);
  if (!settings.clientInstanceId) {
    die("Conductor setting client_instance_id is missing; cannot register creator_client_id");
  }

  return {
    dbPath,
    appVersion,
    migration,
    settings,
  };
}

function readRepoRows(dbPath, rootPath) {
  return sqliteJson(
    dbPath,
    `select id, name, root_path, remote_url, default_branch, remote from repos where root_path = ${sqlValue(rootPath)};`,
  );
}

export function chooseConductorRepo(rows, rootPath, repoId) {
  if (repoId) {
    const match = rows.find((row) => row.id === repoId);
    if (!match) {
      throw new Error(`no Conductor repo row with id ${repoId} for ${rootPath}`);
    }
    return match;
  }
  if (rows.length === 0) {
    throw new Error(`repo is not registered in Conductor: ${rootPath}`);
  }
  if (rows.length === 1) return rows[0];

  const repoName = basename(rootPath);
  const exactNameRows = rows.filter((row) => row.name === repoName);
  if (exactNameRows.length === 1) return exactNameRows[0];

  const choices = rows.map((row) => `${row.id} (${row.name})`).join(", ");
  throw new Error(`multiple Conductor repo rows match ${rootPath}; pass --repo-id. Matches: ${choices}`);
}

function loadConductorRepo(dbPath, repoRootPath, repoId) {
  try {
    return chooseConductorRepo(readRepoRows(dbPath, repoRootPath), repoRootPath, repoId);
  } catch (error) {
    die(error.message);
  }
}

function backupConductorDb(dbPath) {
  const backupDir = backupDirForDb(dbPath);
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `conductor-${backupTimestamp()}.db`);
  const result = run("sqlite3", [dbPath, `.backup '${backupPath.replaceAll("'", "''")}'`], {
    timeout: 15_000,
  });
  if (!result.ok) {
    return copyConductorDbFiles(dbPath, backupPath, result.err || result.out);
  }
  return backupPath;
}

function copyConductorDbFiles(dbPath, backupPath, backupError) {
  try {
    copyFileSync(dbPath, backupPath);
    for (const suffix of ["-wal", "-shm"]) {
      const sidecarPath = `${dbPath}${suffix}`;
      if (existsSync(sidecarPath)) {
        copyFileSync(sidecarPath, `${backupPath}${suffix}`);
      }
    }
  } catch (error) {
    die(`failed to back up Conductor DB with sqlite3 and copy fallback: ${backupError}; ${error.message}`);
  }
  log(`sqlite backup did not complete; copied DB files instead: ${backupError}`);
  return backupPath;
}

function backupTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function sqlValue(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlAssignments(values) {
  return Object.entries(values)
    .map(([key, value]) => `${key} = ${sqlValue(value)}`)
    .join(", ");
}

function insertSql(table, values) {
  const columns = Object.keys(values).join(", ");
  const sqlValues = Object.values(values).map(sqlValue).join(", ");
  return `insert into ${table} (${columns}) values (${sqlValues});`;
}

export function buildConductorRegistrationSql({ workspace, session }) {
  return [
    "begin;",
    insertSql("sessions", session),
    insertSql("workspaces", workspace),
    "commit;",
  ].join("\n");
}

export function buildConductorArchiveSql({ workspaceId, archiveCommit }) {
  return [
    "begin;",
    `update workspaces set ${sqlAssignments({ state: "archived", archive_commit: archiveCommit })} where id = ${sqlValue(workspaceId)};`,
    "commit;",
  ].join("\n");
}

function registerConductorWorkspace({ env, repoRow, slug, branch, targetPath, sessionModel }) {
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  const workspace = {
    id: workspaceId,
    repository_id: repoRow.id,
    directory_name: slug,
    active_session_id: sessionId,
    branch,
    placeholder_branch_name: branch,
    state: "ready",
    initialization_parent_branch: repoRow.default_branch || "main",
    initialization_log_path: null,
    initialization_files_copied: null,
    intended_target_branch: repoRow.default_branch || "main",
    derived_status: "in-progress",
    workspace_path: targetPath,
    permission_level: "write",
    creator_client_id: env.settings.clientInstanceId,
  };
  const session = {
    id: sessionId,
    status: "idle",
    model: sessionModel || DEFAULT_SESSION_MODEL,
    permission_mode: "plan",
    workspace_id: workspaceId,
    is_hidden: 0,
    agent_type: "claude",
    title: "Untitled",
    codex_thinking_level: "high",
    fast_mode: 0,
    agent_personality: "pragmatic",
    claude_effort_level: "medium",
    feed_offset: -1,
  };

  const backupPath = backupConductorDb(env.dbPath);
  sqlite(env.dbPath, buildConductorRegistrationSql({ workspace, session }));

  const rows = sqliteJson(
    env.dbPath,
    [
      "select w.id as workspace_id, s.id as session_id from workspaces w ",
      "join sessions s on s.id = w.active_session_id ",
      `where w.id = ${sqlValue(workspaceId)} and s.id = ${sqlValue(sessionId)};`,
    ].join(""),
  );
  if (rows.length !== 1) {
    die("Conductor registration write did not verify; restore from backup before retrying");
  }

  log(`conductor workspace id: ${workspaceId}`);
  log(`conductor session id: ${sessionId}`);
  log(`conductor db backup: ${backupPath}`);
  log("restart Conductor if the workspace does not appear immediately");
}

function restartConductorApp() {
  if (process.platform !== "darwin") {
    die("--restart-conductor is currently only supported on macOS");
  }

  const quit = run("osascript", ["-e", 'tell application "Conductor" to quit']);
  if (!quit.ok) {
    die(`could not quit Conductor: ${quit.err || quit.out}`);
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const check = run("pgrep", ["-x", "Conductor"]);
    if (!check.ok) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }

  const open = run("open", ["-a", "Conductor"]);
  if (!open.ok) {
    die(`could not reopen Conductor: ${open.err || open.out}`);
  }
  log("restarted Conductor");
}

function herdrWorkspaceList() {
  const result = run(herdrBin(), ["workspace", "list"]);
  if (!result.ok) {
    die(`herdr workspace list failed: ${result.err || result.out}`);
  }
  try {
    return JSON.parse(result.out).result?.workspaces || [];
  } catch (error) {
    die(`herdr workspace list returned invalid JSON: ${error.message}`);
  }
}

function readConductorSyncWorkspaces(env) {
  return sqliteJson(
    env.dbPath,
    [
      "select w.id, w.repository_id, w.directory_name, w.branch, w.state, w.updated_at, ",
      "w.workspace_path, w.archive_commit, r.root_path as repo_root, r.name as repo_name ",
      "from workspaces w ",
      "join repos r on r.id = w.repository_id ",
      "where w.workspace_path is not null ",
      "and r.root_path is not null ",
      "and w.state in ('ready', 'active', 'archived') ",
      "order by datetime(w.updated_at) desc, r.name, w.directory_name;",
    ].join(""),
  );
}

function pathKey(path) {
  return resolve(expandHome(path));
}

function isUnderPath(path, root) {
  const resolvedPath = pathKey(path);
  const resolvedRoot = pathKey(root);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}/`);
}

export function planConductorSync({ conductorWorkspaces, herdrWorkspaces, conductorRoot }) {
  const root = pathKey(conductorRoot);
  const herdrByPath = new Map();
  for (const workspace of herdrWorkspaces) {
    const checkoutPath = workspace.worktree?.checkout_path;
    if (checkoutPath) {
      herdrByPath.set(pathKey(checkoutPath), workspace);
    }
  }

  const conductorRows = conductorWorkspaces
    .filter((workspace) => workspace.workspace_path && isUnderPath(workspace.workspace_path, root))
    .map((workspace) => ({
      ...workspace,
      workspace_path: pathKey(workspace.workspace_path),
      herdrWorkspace: herdrByPath.get(pathKey(workspace.workspace_path)),
    }));

  return {
    newConductorWorkspaces: conductorRows.filter(
      (workspace) =>
        (workspace.state === "ready" || workspace.state === "active") && !workspace.herdrWorkspace,
    ),
    archivedHerdrWorkspaces: conductorRows.filter(
      (workspace) => workspace.state === "archived" && workspace.herdrWorkspace,
    ),
  };
}

function printSyncPlan(plan) {
  log(`new Conductor workspaces not open in Herdr: ${plan.newConductorWorkspaces.length}`);
  for (const workspace of plan.newConductorWorkspaces) {
    log(`  + ${formatSyncWorkspace(workspace)}`);
  }
  log(`Herdr workspaces archived in Conductor: ${plan.archivedHerdrWorkspaces.length}`);
  for (const workspace of plan.archivedHerdrWorkspaces) {
    log(`  - ${formatSyncWorkspace(workspace)} (Herdr ${workspace.herdrWorkspace.workspace_id})`);
  }
}

function formatSyncWorkspace(workspace) {
  return `${workspace.repo_name}/${workspace.directory_name} [${workspace.branch || "detached"}] ${workspace.workspace_path}`;
}

function formatSyncWorkspaceForMenu(workspace) {
  const repo = color(workspace.repo_name, "36;1");
  const branch = color(workspace.branch || "detached", "33;1");
  return `${repo}/${workspace.directory_name} [${branch}] ${workspace.workspace_path}`;
}

function openConductorWorkspaceInHerdr(workspace, { dryRun }) {
  const command = [
    "worktree",
    "open",
    "--cwd",
    workspace.repo_root,
    "--path",
    workspace.workspace_path,
    "--label",
    workspace.directory_name || basename(workspace.workspace_path),
    "--no-focus",
    "--json",
  ];
  if (dryRun) {
    log(`dry-run: ${herdrBin()} ${command.map((part) => JSON.stringify(part)).join(" ")}`);
    return;
  }
  const result = run(herdrBin(), command);
  if (!result.ok) {
    die(`herdr worktree open failed for ${workspace.workspace_path}: ${result.err || result.out}`);
  }
  log(`opened in Herdr: ${formatSyncWorkspace(workspace)}`);
}

function removeArchivedWorkspaceFromHerdr(workspace, { dryRun, force }) {
  const workspaceId = workspace.herdrWorkspace?.workspace_id;
  if (!workspaceId) {
    die(`missing Herdr workspace id for ${workspace.workspace_path}`);
  }
  const command = ["worktree", "remove", "--workspace", workspaceId];
  if (force) command.push("--force");
  command.push("--json");
  if (dryRun) {
    log(`dry-run: ${herdrBin()} ${command.map((part) => JSON.stringify(part)).join(" ")}`);
    return;
  }
  const result = run(herdrBin(), command);
  if (!result.ok) {
    die(`herdr worktree remove failed for ${workspaceId}: ${result.err || result.out}`);
  }
  log(`removed archived Herdr workspace: ${workspaceId} ${formatSyncWorkspace(workspace)}`);
}

export function buildSyncCandidates(plan) {
  return [
    ...plan.newConductorWorkspaces.map((workspace) => ({ action: "open", workspace })),
    ...plan.archivedHerdrWorkspaces.map((workspace) => ({ action: "remove", workspace })),
  ];
}

function formatSyncCandidate(candidate) {
  const prefix = candidate.action === "open" ? "Open in Herdr" : "Remove archived from Herdr";
  return `${prefix}: ${formatSyncWorkspace(candidate.workspace)}`;
}

function color(text, code) {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

function formatSyncCandidateForMenu(candidate) {
  const action =
    candidate.action === "open"
      ? color("Open in Herdr", "32;1")
      : color("Remove archived from Herdr", "31;1");
  return `${action}: ${formatSyncWorkspaceForMenu(candidate.workspace)}`;
}

function readRawKey(input) {
  return new Promise((resolve) => {
    input.once("data", resolve);
  });
}

function renderMultiSelect(candidates, selected, cursor) {
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write("Sync Conductor Workspaces\n\n");
  process.stdout.write("Use Up/Down or j/k to move, Space to toggle, a to toggle all, Enter to apply, q to cancel.\n\n");
  candidates.forEach((candidate, index) => {
    const pointer = index === cursor ? ">" : " ";
    const checkbox = selected.has(index) ? "[x]" : "[ ]";
    process.stdout.write(`${pointer} ${checkbox} ${formatSyncCandidateForMenu(candidate)}\n`);
  });
}

async function selectSyncCandidates(candidates) {
  const selected = new Set();
  let cursor = 0;
  const input = process.stdin;
  const output = process.stdout;
  const wasRaw = input.isRaw;

  input.setRawMode(true);
  input.resume();
  try {
    while (true) {
      renderMultiSelect(candidates, selected, cursor);
      const key = (await readRawKey(input)).toString("utf8");
      if (key === "\u0003") {
        output.write("\n");
        process.exit(130);
      }
      if (key === "\r" || key === "\n") {
        output.write("\x1b[2J\x1b[H");
        return [...selected].sort((a, b) => a - b).map((index) => candidates[index]);
      }
      if (key === "q" || key === "\u001b") {
        output.write("\x1b[2J\x1b[H");
        return [];
      }
      if (key === " " || key === "\t") {
        if (selected.has(cursor)) selected.delete(cursor);
        else selected.add(cursor);
      } else if (key === "a") {
        if (selected.size === candidates.length) selected.clear();
        else candidates.forEach((_, index) => selected.add(index));
      } else if (key === "\u001b[A" || key === "k") {
        cursor = (cursor - 1 + candidates.length) % candidates.length;
      } else if (key === "\u001b[B" || key === "j") {
        cursor = (cursor + 1) % candidates.length;
      }
    }
  } finally {
    input.setRawMode(Boolean(wasRaw));
  }
}

async function applyInteractiveSync(plan, args) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    log("interactive prompt is unavailable; rerun in a terminal or pass --open-new/--remove-archived");
    return;
  }
  const candidates = buildSyncCandidates(plan).filter((candidate) => {
    if (candidate.action !== "open" || existsSync(candidate.workspace.workspace_path)) {
      return true;
    }
    log(`skipping missing Conductor workspace path: ${candidate.workspace.workspace_path}`);
    return false;
  });
  if (candidates.length === 0) {
    log("no sync actions available");
    return;
  }

  const selected = await selectSyncCandidates(candidates);
  if (selected.length === 0) {
    log("no sync actions selected");
    return;
  }
  for (const candidate of selected) {
    if (candidate.action === "open") {
      openConductorWorkspaceInHerdr(candidate.workspace, args);
    } else {
      removeArchivedWorkspaceFromHerdr(candidate.workspace, args);
    }
  }
}

async function syncFromConductorCommand(args) {
  const env = loadConductorEnvironment(args);
  const conductorWorkspaces = readConductorSyncWorkspaces(env);
  const herdrWorkspaces = herdrWorkspaceList();
  const plan = planConductorSync({
    conductorWorkspaces,
    herdrWorkspaces,
    conductorRoot: args.conductorRoot,
  });

  printSyncPlan(plan);

  if (args.interactive) {
    await applyInteractiveSync(plan, args);
    return;
  }
  if (args.openNew) {
    for (const workspace of plan.newConductorWorkspaces) {
      if (!existsSync(workspace.workspace_path)) {
        log(`skipping missing Conductor workspace path: ${workspace.workspace_path}`);
        continue;
      }
      openConductorWorkspaceInHerdr(workspace, args);
    }
  }
  if (args.removeArchived) {
    for (const workspace of plan.archivedHerdrWorkspaces) {
      removeArchivedWorkspaceFromHerdr(workspace, args);
    }
  }
  if (!args.openNew && !args.removeArchived) {
    log("no changes applied; pass --interactive, --open-new, or --remove-archived");
  }
}

function readArchiveWorkspace(env, args) {
  const where = [];
  if (args.workspaceId) where.push(`w.id = ${sqlValue(args.workspaceId)}`);
  if (args.cwd) where.push(`w.workspace_path = ${sqlValue(resolve(expandHome(args.cwd)))}`);
  if (args.branch) where.push(`w.branch = ${sqlValue(args.branch)}`);
  const rows = sqliteJson(
    env.dbPath,
    [
      "select w.id, w.repository_id, w.branch, w.workspace_path, w.state, w.archive_commit, ",
      "r.root_path as repo_root, r.name as repo_name from workspaces w ",
      "left join repos r on r.id = w.repository_id ",
      `where ${where.join(" and ")};`,
    ].join(""),
  );
  if (rows.length === 0) {
    die("no Conductor workspace matched the archive selector");
  }
  if (rows.length > 1) {
    die(`archive selector matched ${rows.length} workspaces; use --workspace-id`);
  }
  return rows[0];
}

function archiveConductorWorkspace(args) {
  const env = loadConductorEnvironment(args);
  const workspace = readArchiveWorkspace(env, args);
  if (workspace.state === "archived") {
    die(`workspace is already archived: ${workspace.id}`);
  }
  if (!workspace.workspace_path || !workspace.repo_root || !workspace.branch) {
    die(`workspace row is missing required archive fields: ${workspace.id}`);
  }
  if (!existsSync(workspace.workspace_path)) {
    die(`workspace path does not exist: ${workspace.workspace_path}`);
  }
  if (!args.force && !worktreeIsClean(workspace.workspace_path)) {
    die(`workspace has uncommitted changes; pass --force to archive anyway: ${workspace.workspace_path}`);
  }

  const head = git(workspace.workspace_path, "rev-parse", "HEAD");
  if (!head.ok || !head.out) {
    die(`could not read worktree HEAD: ${head.err || head.out}`);
  }

  const backupPath = backupConductorDb(env.dbPath);
  const removeArgs = ["worktree", "remove"];
  if (args.force) removeArgs.push("--force");
  removeArgs.push(workspace.workspace_path);
  const removed = git(workspace.repo_root, ...removeArgs);
  if (!removed.ok) {
    die(`git worktree remove failed: ${removed.err || removed.out}`);
  }

  if (env.settings.deleteBranchOnArchive && branchExists(workspace.repo_root, workspace.branch)) {
    const deleted = git(workspace.repo_root, "branch", "-D", workspace.branch);
    if (!deleted.ok) {
      die(`git branch delete failed: ${deleted.err || deleted.out}`);
    }
  }

  sqlite(env.dbPath, buildConductorArchiveSql({ workspaceId: workspace.id, archiveCommit: head.out }));
  const rows = sqliteJson(
    env.dbPath,
    `select id, state, archive_commit from workspaces where id = ${sqlValue(workspace.id)};`,
  );
  if (rows[0]?.state !== "archived" || rows[0]?.archive_commit !== head.out || existsSync(workspace.workspace_path)) {
    die("archive verification failed; inspect Conductor DB backup before retrying");
  }

  log(`archived conductor workspace id: ${workspace.id}`);
  log(`archive commit: ${head.out}`);
  log(`conductor db backup: ${backupPath}`);
  log("restart Conductor if the archived state does not appear immediately");
}

function createCommand(args) {
  const repo = repoRoot(resolve(sourceCwd(args.cwd)));
  const slug = slugify(args.slug || timestampSlug());
  const env = args.registerConductor ? loadConductorEnvironment(args) : undefined;
  const repoRow = env ? loadConductorRepo(env.dbPath, repo, args.repoId) : undefined;
  const prefix = env ? conductorBranchPrefix(env.settings) : readConductorBranchPrefix();
  const branch = `${prefix}${slug}`;
  const targetPath = conductorPath(repo, slug, args.conductorRoot);

  if (existsSync(targetPath)) {
    die(`target path already exists: ${targetPath}`);
  }
  if (branchExists(repo, branch)) {
    die(`branch already exists: ${branch}`);
  }

  log(`repo: ${repo}`);
  log(`workspace: ${slug}`);
  log(`branch: ${branch}`);
  log(`path: ${targetPath}`);

  createWorktree({ repo, slug, branch, targetPath, dryRun: args.dryRun });

  if (args.registerConductor) {
    if (args.dryRun) {
      log("dry-run: skipped Conductor DB registration");
      return;
    }
    registerConductorWorkspace({
      env,
      repoRow,
      slug,
      branch,
      targetPath,
      sessionModel: args.sessionModel,
    });
    if (args.restartConductor) {
      restartConductorApp();
    }
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    die(error.message);
  }

  if (args.command === "create") {
    createCommand(args);
  } else if (args.command === "archive") {
    archiveConductorWorkspace(args);
    if (args.restartConductor) {
      restartConductorApp();
    }
  } else if (args.command === "sync-from-conductor") {
    await syncFromConductorCommand(args);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    die(error.message);
  });
}
