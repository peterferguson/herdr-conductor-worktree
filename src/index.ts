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
  { appVersion: "0.71.1", migrationMax: 114 },
  { appVersion: "0.72.0", migrationMax: 115 },
  { appVersion: "0.73.0", migrationMax: 115 },
  { appVersion: "0.73.3", migrationMax: 115 },
  { appVersion: "0.74.0", migrationMax: 115 },
];
const DEFAULT_SESSION_MODEL = "opus-4-8-1m";

type Command =
  | "create"
  | "create-panel"
  | "create-branch-panel"
  | "archive"
  | "archive-panel"
  | "agent-panel"
  | "sync-from-conductor"
  | undefined;

interface CliArgs {
  command: Command;
  cwd?: string;
  workspaceId?: string;
  branch?: string;
  base?: string;
  slug?: string;
  conductorRoot: string;
  conductorApp: string;
  conductorDb: string;
  repoId?: string;
  herdrWorkspaceId?: string;
  sessionModel: string;
  dryRun: boolean;
  registerConductor: boolean;
  restartConductor: boolean;
  interactive: boolean;
  openNew: boolean;
  removeArchived: boolean;
  unsafeConductorVersion: boolean;
  force: boolean;
}

interface RunResult {
  ok: boolean;
  out: string;
  err: string;
  status: number | null;
}

interface ConductorSettings {
  clientInstanceId: string;
  branchPrefixType: string;
  branchPrefixCustom: string;
  deleteBranchOnArchive: boolean;
}

interface ConductorRepoRow {
  id: string;
  name: string;
  root_path: string;
  remote_url?: string;
  default_branch?: string;
  remote?: string;
}

interface ConductorEnvironment {
  dbPath: string;
  appVersion: string;
  migration: {
    maxVersion: number;
    count: number;
  };
  settings: ConductorSettings;
}

interface RegistrationWorkspace {
  id: string;
  repository_id: string;
  directory_name: string;
  active_session_id: string;
  branch: string;
  workspace_path: string;
  creator_client_id: string;
  [key: string]: string | number | null;
}

interface RegistrationSession {
  id: string;
  status: string;
  model: string;
  permission_mode: string;
  workspace_id: string;
  is_hidden: number;
  [key: string]: string | number;
}

interface ConductorWorkspaceRow {
  id: string;
  repository_id?: string;
  repo_name: string;
  repo_root: string;
  directory_name: string;
  branch?: string;
  state: string;
  updated_at?: string;
  workspace_path: string;
  archive_commit?: string | null;
}

interface HerdrWorkspace {
  workspace_id: string;
  worktree?: {
    checkout_path?: string;
  };
}

interface HerdrAgent {
  agent?: string;
  agent_status?: string;
  cwd?: string;
  focused?: boolean;
  pane_id: string;
  tab_id?: string;
  workspace_id?: string;
}

type SyncWorkspace = ConductorWorkspaceRow & {
  herdrWorkspace?: HerdrWorkspace;
};

interface SyncPlan {
  newConductorWorkspaces: SyncWorkspace[];
  archivedHerdrWorkspaces: SyncWorkspace[];
}

type SyncCandidate =
  | { action: "open"; workspace: SyncWorkspace }
  | { action: "remove"; workspace: SyncWorkspace };

function log(message: string) {
  process.stdout.write(`${TAG} ${message}\n`);
}

function notifyPluginError(message: string): void {
  if (!process.env.HERDR_PLUGIN_ACTION_ID) return;
  spawnSync(
    herdrBin(),
    [
      "notification",
      "show",
      "Conductor worktree failed",
      "--body",
      message,
      "--position",
      "bottom-right",
      "--sound",
      "request",
    ],
    { encoding: "utf8", timeout: 2000 },
  );
}

function die(message: string): never {
  notifyPluginError(message);
  process.stderr.write(`${TAG} error: ${message}\n`);
  process.exit(1);
}

export function slugify(value: unknown): string {
  const slug = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug || "workspace";
}

export function timestampSlug(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("");
  const time = [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join("");
  return `herdr-test-${stamp}-${time}`;
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function parseBranchPrefix(settingsToml: string): string {
  const match = settingsToml.match(/^\s*branch_prefix\s*=\s*"([^"]*)"\s*$/m);
  return match ? match[1] : "";
}

export function readConductorBranchPrefix(settingsPath = join(homedir(), ".conductor", "settings.toml")): string {
  if (!existsSync(settingsPath)) return "";
  return parseBranchPrefix(readFileSync(settingsPath, "utf8"));
}

export function conductorPath(repoRoot: string, workspaceSlug: string, conductorRoot = "~/conductor/workspaces"): string {
  return resolve(expandHome(conductorRoot), basename(repoRoot), workspaceSlug);
}

export function branchWorkspaceSlug(branch: string, explicitSlug?: string): string {
  return slugify(explicitSlug || branch);
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: argv[0] as Command,
    cwd: undefined,
    workspaceId: undefined,
    branch: undefined,
    base: undefined,
    slug: undefined,
    conductorRoot: process.env.CONDUCTOR_WORKTREE_ROOT || "~/conductor/workspaces",
    conductorApp: process.env.CONDUCTOR_APP_PATH || "/Applications/Conductor.app",
    conductorDb: process.env.CONDUCTOR_DB_PATH || defaultConductorDbPath(),
    repoId: undefined,
    herdrWorkspaceId: undefined,
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
    } else if (arg === "--base") {
      args.base = argv[++i];
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
    } else if (arg === "--herdr-workspace-id") {
      args.herdrWorkspaceId = argv[++i];
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
  if (args.command === "create-panel") {
    args.registerConductor = true;
    return args;
  }
  if (args.command === "create-branch-panel") {
    args.registerConductor = true;
    return args;
  }
  if (args.command === "archive") {
    if (!args.workspaceId && !args.cwd && !args.branch) {
      throw new Error("archive requires one of --workspace-id, --cwd, or --branch");
    }
    return args;
  }
  if (args.command === "archive-panel") {
    return args;
  }
  if (args.command === "agent-panel") {
    return args;
  }
  if (args.command === "sync-from-conductor") {
    return args;
  }
  throw new Error(
    [
      "usage:",
      "  herdr-conductor-worktree create [--cwd PATH] [--slug NAME] [--branch NAME] [--base REF] [--conductor-root PATH] [--dry-run] [--register-conductor] [--restart-conductor]",
      "  herdr-conductor-worktree create-panel [--cwd PATH] [--conductor-root PATH]",
      "  herdr-conductor-worktree create-branch-panel [--cwd PATH] [--conductor-root PATH]",
      "  herdr-conductor-worktree archive (--workspace-id ID | --cwd PATH | --branch NAME) [--force] [--restart-conductor] [--herdr-workspace-id ID]",
      "  herdr-conductor-worktree archive-panel [--cwd PATH]",
      "  herdr-conductor-worktree agent-panel",
      "  herdr-conductor-worktree sync-from-conductor [--interactive] [--open-new] [--remove-archived] [--dry-run]",
    ].join("\n"),
  );
}

function pluginContext(): Record<string, string> {
  try {
    return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  } catch {
    return {};
  }
}

function sourceCwd(explicitCwd?: string): string {
  if (explicitCwd) return explicitCwd;
  const ctx = pluginContext();
  return ctx.focused_pane_cwd || ctx.workspace_cwd || process.cwd();
}

function run(command: string, args: string[], options: { cwd?: string; timeout?: number } = {}): RunResult {
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

function git(cwd: string, ...args: string[]): RunResult {
  return run("git", ["-C", cwd, ...args]);
}

function repoRoot(cwd: string): string {
  const result = git(cwd, "rev-parse", "--show-toplevel");
  if (!result.ok || !result.out) {
    die(`${cwd} is not inside a Git repository`);
  }
  return result.out;
}

function branchExists(repo: string, branch: string): boolean {
  return git(repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`).ok;
}

function refExists(repo: string, ref: string): boolean {
  return git(repo, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`).ok;
}

function branchNameIsValid(repo: string, branch: string): boolean {
  return git(repo, "check-ref-format", "--branch", branch).ok;
}

function remoteBranchBase(repo: string, branch: string): string | undefined {
  const remotes = git(repo, "remote");
  if (!remotes.ok || !remotes.out) return undefined;
  const names = remotes.out.split("\n").map((remote) => remote.trim()).filter(Boolean);
  const ordered = [...new Set(["origin", ...names])].filter((remote) => names.includes(remote));
  for (const remote of ordered) {
    if (refExists(repo, `refs/remotes/${remote}/${branch}`)) {
      return `${remote}/${branch}`;
    }
  }
  return undefined;
}

function worktreeIsClean(worktreePath: string): boolean {
  const result = git(worktreePath, "status", "--porcelain");
  return result.ok && result.out === "";
}

function herdrBin(): string {
  return process.env.HERDR_BIN_PATH || "herdr";
}

export function buildHerdrWorktreeCreateCommand({
  repo,
  slug,
  branch,
  base,
  targetPath,
}: {
  repo: string;
  slug: string;
  branch: string;
  base?: string;
  targetPath: string;
}): string[] {
  const command = [
    "worktree",
    "create",
    "--cwd",
    repo,
    "--branch",
    branch,
  ];
  if (base) {
    command.push("--base", base);
  }
  command.push(
    "--path",
    targetPath,
    "--label",
    slug,
    "--no-focus",
    "--json",
  );
  return command;
}

export function buildHerdrWorkspaceCreateCommand(targetPath: string, slug: string): string[] {
  return ["workspace", "create", "--cwd", targetPath, "--label", slug, "--focus"];
}

function createWorktree({
  repo,
  slug,
  branch,
  base,
  targetPath,
  dryRun,
}: {
  repo: string;
  slug: string;
  branch: string;
  base?: string;
  targetPath: string;
  dryRun: boolean;
}): void {
  const command = buildHerdrWorktreeCreateCommand({ repo, slug, branch, base, targetPath });

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

function createHerdrWorkspace({
  slug,
  targetPath,
  dryRun,
}: {
  slug: string;
  targetPath: string;
  dryRun: boolean;
}): void {
  const command = buildHerdrWorkspaceCreateCommand(targetPath, slug);

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

export function defaultConductorDbPath(): string {
  return join(homedir(), "Library", "Application Support", "com.conductor.app", "conductor.db");
}

function conductorSupportDir(dbPath: string): string {
  return dirname(dbPath);
}

function backupDirForDb(dbPath: string): string {
  return join(conductorSupportDir(dbPath), "backups", "herdr-conductor-worktree");
}

export function parseConductorVersion(output: unknown): string {
  return String(output).trim();
}

function readConductorAppVersion(appPath: string): string {
  const plistPath = join(appPath, "Contents", "Info.plist");
  const result = run("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plistPath]);
  if (!result.ok) {
    die(`could not read Conductor version from ${plistPath}: ${result.err || result.out}`);
  }
  return parseConductorVersion(result.out);
}

function sqlite(dbPath: string, sql: string, options: { json?: boolean; header?: boolean } = {}): string {
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

function sqliteJson<T = Record<string, unknown>>(dbPath: string, sql: string): T[] {
  const out = sqlite(dbPath, sql, { json: true });
  if (!out) return [];
  try {
    return JSON.parse(out);
  } catch (error) {
    die(`sqlite3 returned invalid JSON: ${error.message}`);
  }
}

function readMigrationWatermark(dbPath: string): { maxVersion: number; count: number } {
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

export function assertConductorCompatibility({
  appVersion,
  migrationMax,
  unsafe,
}: {
  appVersion: string;
  migrationMax: number;
  unsafe: boolean;
}): void {
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

function formatSupportedBaselines(): string {
  return SUPPORTED_CONDUCTOR_BASELINES.map(
    (baseline) => `app ${baseline.appVersion}, migration ${baseline.migrationMax}`,
  ).join(" or ");
}

export function parseConductorSettings(rows: Array<{ key: string; value: unknown }>): ConductorSettings {
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return {
    clientInstanceId: values.client_instance_id || "",
    branchPrefixType: values.branch_prefix_type || "",
    branchPrefixCustom: values.branch_prefix_custom || "",
    deleteBranchOnArchive: parseBooleanSetting(values.delete_branch_on_archive),
  };
}

function parseBooleanSetting(value: unknown): boolean {
  if (value === true || value === 1) return true;
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function readConductorSettings(dbPath: string): ConductorSettings {
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

function conductorBranchPrefix(settings: ConductorSettings): string {
  if (settings.branchPrefixType === "custom") return settings.branchPrefixCustom || "";
  return "";
}

function loadConductorEnvironment(args: CliArgs): ConductorEnvironment {
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

function readRepoRows(dbPath: string, rootPath: string): ConductorRepoRow[] {
  return sqliteJson<ConductorRepoRow>(
    dbPath,
    `select id, name, root_path, remote_url, default_branch, remote from repos where root_path = ${sqlValue(rootPath)};`,
  );
}

export function chooseConductorRepo(rows: ConductorRepoRow[], rootPath: string, repoId?: string): ConductorRepoRow {
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

function loadConductorRepo(dbPath: string, repoRootPath: string, repoId?: string): ConductorRepoRow {
  try {
    return chooseConductorRepo(readRepoRows(dbPath, repoRootPath), repoRootPath, repoId);
  } catch (error) {
    die(error.message);
  }
}

function backupConductorDb(dbPath: string): string {
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

function copyConductorDbFiles(dbPath: string, backupPath: string, backupError: string): string {
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

function backupTimestamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
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

function sqlValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlAssignments(values: Record<string, unknown>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key} = ${sqlValue(value)}`)
    .join(", ");
}

function insertSql(table: string, values: Record<string, unknown>): string {
  const columns = Object.keys(values).join(", ");
  const sqlValues = Object.values(values).map(sqlValue).join(", ");
  return `insert into ${table} (${columns}) values (${sqlValues});`;
}

export function buildConductorRegistrationSql({
  workspace,
  session,
}: {
  workspace: RegistrationWorkspace;
  session: RegistrationSession;
}): string {
  return [
    "begin;",
    insertSql("sessions", session),
    insertSql("workspaces", workspace),
    "commit;",
  ].join("\n");
}

export function buildConductorArchiveSql({
  workspaceId,
  archiveCommit,
}: {
  workspaceId: string;
  archiveCommit: string;
}): string {
  return [
    "begin;",
    `update workspaces set ${sqlAssignments({ state: "archived", archive_commit: archiveCommit })} where id = ${sqlValue(workspaceId)};`,
    "commit;",
  ].join("\n");
}

function registerConductorWorkspace({
  env,
  repoRow,
  slug,
  branch,
  targetPath,
  sessionModel,
}: {
  env: ConductorEnvironment;
  repoRow: ConductorRepoRow;
  slug: string;
  branch: string;
  targetPath: string;
  sessionModel: string;
}): void {
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

function restartConductorApp(): void {
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

function herdrWorkspaceList(): HerdrWorkspace[] {
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

function readConductorSyncWorkspaces(env: ConductorEnvironment): ConductorWorkspaceRow[] {
  return sqliteJson<ConductorWorkspaceRow>(
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

function pathKey(path: string): string {
  return resolve(expandHome(path));
}

function isUnderPath(path: string, root: string): boolean {
  const resolvedPath = pathKey(path);
  const resolvedRoot = pathKey(root);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}/`);
}

export function planConductorSync({
  conductorWorkspaces,
  herdrWorkspaces,
  conductorRoot,
}: {
  conductorWorkspaces: ConductorWorkspaceRow[];
  herdrWorkspaces: HerdrWorkspace[];
  conductorRoot: string;
}): SyncPlan {
  const root = pathKey(conductorRoot);
  const herdrByPath = new Map<string, HerdrWorkspace>();
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

function printSyncPlan(plan: SyncPlan): void {
  log(`new Conductor workspaces not open in Herdr: ${plan.newConductorWorkspaces.length}`);
  for (const workspace of plan.newConductorWorkspaces) {
    log(`  + ${formatSyncWorkspace(workspace)}`);
  }
  log(`Herdr workspaces archived in Conductor: ${plan.archivedHerdrWorkspaces.length}`);
  for (const workspace of plan.archivedHerdrWorkspaces) {
    log(`  - ${formatSyncWorkspace(workspace)} (Herdr ${workspace.herdrWorkspace.workspace_id})`);
  }
}

function formatSyncWorkspace(workspace: SyncWorkspace): string {
  return `${workspace.repo_name}/${workspace.directory_name} [${workspace.branch || "detached"}] ${workspace.workspace_path}`;
}

function formatSyncWorkspaceForMenu(workspace: SyncWorkspace): string {
  const repo = color(workspace.repo_name, "36;1");
  const branch = color(workspace.branch || "detached", "33;1");
  return `${repo}/${workspace.directory_name} [${branch}] ${workspace.workspace_path}`;
}

function openConductorWorkspaceInHerdr(workspace: SyncWorkspace, { dryRun }: Pick<CliArgs, "dryRun">): void {
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

function removeArchivedWorkspaceFromHerdr(
  workspace: SyncWorkspace,
  { dryRun, force }: Pick<CliArgs, "dryRun" | "force">,
): void {
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

export function buildSyncCandidates(plan: SyncPlan): SyncCandidate[] {
  return [
    ...plan.newConductorWorkspaces.map((workspace) => ({ action: "open", workspace })),
    ...plan.archivedHerdrWorkspaces.map((workspace) => ({ action: "remove", workspace })),
  ];
}

function formatSyncCandidate(candidate: SyncCandidate): string {
  const prefix = candidate.action === "open" ? "Open in Herdr" : "Remove archived from Herdr";
  return `${prefix}: ${formatSyncWorkspace(candidate.workspace)}`;
}

function color(text: string, code: string): string {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

function formatSyncCandidateForMenu(candidate: SyncCandidate): string {
  const action =
    candidate.action === "open"
      ? color("Open in Herdr", "32;1")
      : color("Remove archived from Herdr", "31;1");
  return `${action}: ${formatSyncWorkspaceForMenu(candidate.workspace)}`;
}

function readRawKey(input: NodeJS.ReadStream): Promise<Buffer> {
  return new Promise((resolve) => {
    input.once("data", resolve);
  });
}

function renderMultiSelect(candidates: SyncCandidate[], selected: Set<number>, cursor: number): void {
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write("Sync Conductor Workspaces\n\n");
  process.stdout.write("Use Up/Down or j/k to move, Space to toggle, a to toggle all, Enter to apply, q to cancel.\n\n");
  candidates.forEach((candidate, index) => {
    const pointer = index === cursor ? ">" : " ";
    const checkbox = selected.has(index) ? "[x]" : "[ ]";
    process.stdout.write(`${pointer} ${checkbox} ${formatSyncCandidateForMenu(candidate)}\n`);
  });
}

async function selectSyncCandidates(candidates: SyncCandidate[]): Promise<SyncCandidate[]> {
  const selected = new Set<number>();
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

async function applyInteractiveSync(plan: SyncPlan, args: CliArgs): Promise<void> {
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

async function syncFromConductorCommand(args: CliArgs): Promise<void> {
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

function readArchiveWorkspace(env: ConductorEnvironment, args: CliArgs): ConductorWorkspaceRow {
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

function archiveConductorWorkspace(args: CliArgs): void {
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
  if (args.herdrWorkspaceId) {
    const removeHerdr = run(herdrBin(), ["worktree", "remove", "--workspace", args.herdrWorkspaceId, "--force", "--json"]);
    if (!removeHerdr.ok) {
      die(`archived Conductor workspace but Herdr removal failed: ${removeHerdr.err || removeHerdr.out}`);
    }
    log(`removed Herdr workspace: ${args.herdrWorkspaceId}`);
  }
  log("restart Conductor if the archived state does not appear immediately");
}

function createCommand(args: CliArgs): void {
  const repo = repoRoot(resolve(sourceCwd(args.cwd)));
  const env = args.registerConductor ? loadConductorEnvironment(args) : undefined;
  const repoRow = env ? loadConductorRepo(env.dbPath, repo, args.repoId) : undefined;
  const requestedBranch = args.branch?.trim();
  if (args.branch !== undefined && !requestedBranch) {
    die("--branch must not be empty");
  }
  const slug = requestedBranch ? branchWorkspaceSlug(requestedBranch, args.slug) : slugify(args.slug || timestampSlug());
  const prefix = requestedBranch ? "" : env ? conductorBranchPrefix(env.settings) : readConductorBranchPrefix();
  const branch = requestedBranch ? requestedBranch : `${prefix}${slug}`;
  const localBranchExists = branchExists(repo, branch);
  const base = args.base || (requestedBranch && !localBranchExists ? remoteBranchBase(repo, branch) : undefined);
  const targetPath = conductorPath(repo, slug, args.conductorRoot);

  if (!branchNameIsValid(repo, branch)) {
    die(`invalid branch name: ${branch}`);
  }
  if (existsSync(targetPath)) {
    die(`target path already exists: ${targetPath}`);
  }
  if (!requestedBranch && localBranchExists) {
    die(`branch already exists: ${branch}`);
  }
  if (requestedBranch && !localBranchExists && !base) {
    die(`branch does not exist locally or on a remote: ${branch}; pass --base REF to create it`);
  }

  log(`repo: ${repo}`);
  log(`workspace: ${slug}`);
  log(`branch: ${branch}`);
  if (base) log(`base: ${base}`);
  log(`path: ${targetPath}`);

  createWorktree({ repo, slug, branch, base, targetPath, dryRun: args.dryRun });
  createHerdrWorkspace({ slug, targetPath, dryRun: args.dryRun });

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

function panelCwd(args: CliArgs): string {
  if (process.env.CONDUCTOR_WORKTREE_PANEL_CWD) {
    return resolve(process.env.CONDUCTOR_WORKTREE_PANEL_CWD);
  }
  return resolve(sourceCwd(args.cwd));
}

function archivePanelCwd(args: CliArgs): string {
  if (process.env.CONDUCTOR_WORKTREE_ARCHIVE_PANEL_CWD) {
    return resolve(process.env.CONDUCTOR_WORKTREE_ARCHIVE_PANEL_CWD);
  }
  return resolve(sourceCwd(args.cwd));
}

function truncateForPanel(value: string, width: number): string {
  const chars = [...value];
  if (chars.length <= width) return value;
  return `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
}

function createPanelCommand(args: CliArgs): void {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const esc = "\x1b[";
  const cwd = panelCwd(args);
  const repoResult = git(cwd, "rev-parse", "--show-toplevel");
  const repo = repoResult.ok ? repoResult.out : cwd;
  let input = timestampSlug();
  let mode: "ready" | "running" | "result" | "error" = repoResult.ok ? "ready" : "error";
  let message = repoResult.ok ? "" : `${cwd} is not inside a Git repository`;
  let terminalRestored = false;

  const clear = () => stdout.write("\x1b[2J\x1b[H");
  const restoreTerminal = () => {
    if (terminalRestored) return;
    stdout.write("\x1b[?25h\x1b[?1049l\x1b[0m");
    if (stdin.isTTY) stdin.setRawMode(false);
    terminalRestored = true;
  };
  const close = (code = 0) => {
    restoreTerminal();
    process.exit(code);
  };
  const render = () => {
    const cols = stdout.columns || 80;
    clear();
    stdout.write(`${esc}1mCreate Conductor + Herdr worktree${esc}0m  ${esc}2mEnter creates · Esc quits${esc}0m\n\n`);
    stdout.write(`${esc}2mRepo${esc}0m ${truncateForPanel(repo, cols - 6)}\n\n`);
    if (mode === "ready") {
      stdout.write(`${esc}36mWorkspace${esc}0m ${input}\n`);
      return;
    }
    if (mode === "running") {
      stdout.write(`${esc}33mCreating ${input}…${esc}0m\n`);
      return;
    }
    const color = mode === "result" ? "32" : "31";
    stdout.write(`${esc}${color}m${truncateForPanel(message, cols)}${esc}0m\n\n`);
    stdout.write(`${esc}2mPress any key to close.${esc}0m`);
  };
  const runCreate = () => {
    const slug = slugify(input);
    input = slug;
    mode = "running";
    render();
    const result = run(process.execPath, [
      process.argv[1],
      "create",
      "--cwd",
      cwd,
      "--slug",
      slug,
      "--register-conductor",
    ]);
    if (result.ok) {
      mode = "result";
      message = result.out || `Created ${slug}`;
    } else {
      mode = "error";
      message = result.err || result.out || `create failed with status ${result.status}`;
    }
    render();
  };
  const onKey = (buf: Buffer) => {
    const key = buf.toString("utf8");
    if (mode === "result" || mode === "error") close(mode === "result" ? 0 : 1);
    if (key === "\x03" || key === "\x04" || key === "\x1b") close(0);
    if (key === "\r" || key === "\n") return void runCreate();
    if (key === "\x7f" || key === "\b") input = input.slice(0, -1);
    else if (key === "\x15") input = "";
    else if (!key.startsWith("\x1b") && /^[\x20-\x7e]+$/.test(key)) input += key;
    render();
  };

  if (!stdin.isTTY || !stdout.isTTY) {
    die("create-panel needs a TTY");
  }

  stdout.write("\x1b[?1049h\x1b[?25l");
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onKey);
  process.on("SIGWINCH", render);
  render();
}

function createBranchPanelCommand(args: CliArgs): void {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const esc = "\x1b[";
  const cwd = panelCwd(args);
  const repoResult = git(cwd, "rev-parse", "--show-toplevel");
  const repo = repoResult.ok ? repoResult.out : cwd;
  let input = "";
  let mode: "ready" | "running" | "result" | "error" = repoResult.ok ? "ready" : "error";
  let message = repoResult.ok ? "" : `${cwd} is not inside a Git repository`;
  let terminalRestored = false;

  const clear = () => stdout.write("\x1b[2J\x1b[H");
  const restoreTerminal = () => {
    if (terminalRestored) return;
    stdout.write("\x1b[?25h\x1b[?1049l\x1b[0m");
    if (stdin.isTTY) stdin.setRawMode(false);
    terminalRestored = true;
  };
  const close = (code = 0) => {
    restoreTerminal();
    process.exit(code);
  };
  const render = () => {
    const cols = stdout.columns || 80;
    clear();
    stdout.write(`${esc}1mCreate Conductor + Herdr worktree from branch${esc}0m  ${esc}2mEnter creates · Esc quits${esc}0m\n\n`);
    stdout.write(`${esc}2mRepo${esc}0m ${truncateForPanel(repo, cols - 6)}\n\n`);
    if (mode === "ready") {
      stdout.write(`${esc}36mBranch${esc}0m ${input}\n`);
      return;
    }
    if (mode === "running") {
      stdout.write(`${esc}33mCreating ${input}…${esc}0m\n`);
      return;
    }
    const color = mode === "result" ? "32" : "31";
    stdout.write(`${esc}${color}m${truncateForPanel(message, cols)}${esc}0m\n\n`);
    stdout.write(`${esc}2mPress any key to close.${esc}0m`);
  };
  const runCreate = () => {
    const branch = input.trim();
    if (!branch) {
      message = "branch must not be empty";
      mode = "error";
      render();
      return;
    }
    input = branch;
    mode = "running";
    render();
    const result = run(process.execPath, [
      process.argv[1],
      "create",
      "--cwd",
      cwd,
      "--branch",
      branch,
      "--register-conductor",
    ]);
    if (result.ok) {
      mode = "result";
      message = result.out || `Created ${branch}`;
    } else {
      mode = "error";
      message = result.err || result.out || `create failed with status ${result.status}`;
    }
    render();
  };
  const onKey = (buf: Buffer) => {
    const key = buf.toString("utf8");
    if (mode === "result" || mode === "error") close(mode === "result" ? 0 : 1);
    if (key === "\x03" || key === "\x04" || key === "\x1b") close(0);
    if (key === "\r" || key === "\n") return void runCreate();
    if (key === "\x7f" || key === "\b") input = input.slice(0, -1);
    else if (key === "\x15") input = "";
    else if (!key.startsWith("\x1b") && /^[\x20-\x7e]+$/.test(key)) input += key;
    render();
  };

  if (!stdin.isTTY || !stdout.isTTY) {
    die("create-branch-panel needs a TTY");
  }

  stdout.write("\x1b[?1049h\x1b[?25l");
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onKey);
  process.on("SIGWINCH", render);
  render();
}

function archivePanelCommand(args: CliArgs): void {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const esc = "\x1b[";
  const cwd = archivePanelCwd(args);
  const herdrWorkspaceId = process.env.CONDUCTOR_WORKTREE_ARCHIVE_HERDR_WORKSPACE_ID || args.herdrWorkspaceId || "";
  let input = "";
  let force = false;
  let mode: "ready" | "running" | "result" | "error" = "ready";
  let message = "";
  let terminalRestored = false;

  const clear = () => stdout.write("\x1b[2J\x1b[H");
  const restoreTerminal = () => {
    if (terminalRestored) return;
    stdout.write("\x1b[?25h\x1b[?1049l\x1b[0m");
    if (stdin.isTTY) stdin.setRawMode(false);
    terminalRestored = true;
  };
  const close = (code = 0) => {
    restoreTerminal();
    process.exit(code);
  };
  const render = () => {
    const cols = stdout.columns || 80;
    clear();
    stdout.write(`${esc}1mArchive Conductor + Herdr worktree${esc}0m  ${esc}2mEnter archives · f toggles force · Esc quits${esc}0m\n\n`);
    stdout.write(`${esc}2mWorktree${esc}0m ${truncateForPanel(cwd, cols - 11)}\n`);
    stdout.write(`${esc}2mHerdr${esc}0m ${herdrWorkspaceId || "unknown"}\n\n`);
    if (mode === "ready") {
      stdout.write(`${esc}33mType archive to confirm${esc}0m ${input}\n`);
      stdout.write(`${esc}2mForce dirty worktree: ${force ? "yes" : "no"}${esc}0m\n`);
      return;
    }
    if (mode === "running") {
      stdout.write(`${esc}33mArchiving…${esc}0m\n`);
      return;
    }
    const color = mode === "result" ? "32" : "31";
    stdout.write(`${esc}${color}m${truncateForPanel(message, cols)}${esc}0m\n\n`);
    stdout.write(`${esc}2mPress any key to close.${esc}0m`);
  };
  const runArchive = () => {
    if (input !== "archive") {
      message = "confirmation text did not match";
      mode = "error";
      render();
      return;
    }
    mode = "running";
    render();
    const command = [
      process.argv[1],
      "archive",
      "--cwd",
      cwd,
    ];
    if (force) command.push("--force");
    if (herdrWorkspaceId) command.push("--herdr-workspace-id", herdrWorkspaceId);
    const result = run(process.execPath, command);
    if (result.ok) {
      mode = "result";
      message = result.out || "Archived worktree";
    } else {
      mode = "error";
      message = result.err || result.out || `archive failed with status ${result.status}`;
    }
    render();
  };
  const onKey = (buf: Buffer) => {
    const key = buf.toString("utf8");
    if (mode === "result" || mode === "error") close(mode === "result" ? 0 : 1);
    if (key === "\x03" || key === "\x04" || key === "\x1b") close(0);
    if (key === "\r" || key === "\n") return void runArchive();
    if (key === "\x7f" || key === "\b") input = input.slice(0, -1);
    else if (key === "\x15") input = "";
    else if (key === "f") force = !force;
    else if (!key.startsWith("\x1b") && /^[\x20-\x7e]+$/.test(key)) input += key;
    render();
  };

  if (!stdin.isTTY || !stdout.isTTY) {
    die("archive-panel needs a TTY");
  }

  stdout.write("\x1b[?1049h\x1b[?25l");
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onKey);
  process.on("SIGWINCH", render);
  render();
}

function herdrAgentList(): HerdrAgent[] {
  const result = run(herdrBin(), ["agent", "list"]);
  if (!result.ok) {
    die(`herdr agent list failed: ${result.err || result.out}`);
  }
  try {
    return (JSON.parse(result.out).result.agents || []).filter((agent: HerdrAgent) => agent.agent);
  } catch (error) {
    die(`herdr agent list returned invalid JSON: ${error.message}`);
  }
}

function formatAgent(agent: HerdrAgent): string {
  const label = agent.agent || "unknown";
  const status = agent.agent_status || "unknown";
  const cwd = agent.cwd || "";
  return `${label} ${status} ${cwd}`;
}

function agentPanelCommand(): void {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const esc = "\x1b[";
  let agents = herdrAgentList();
  let selected = Math.max(0, agents.findIndex((agent) => agent.focused));
  let mode: "ready" | "error" = "ready";
  let message = "";
  let terminalRestored = false;

  const clear = () => stdout.write("\x1b[2J\x1b[H");
  const visibleCount = () => Math.max(3, Math.min((stdout.rows || 24) - 5, 16));
  const restoreTerminal = () => {
    if (terminalRestored) return;
    stdout.write("\x1b[?25h\x1b[?1049l\x1b[0m");
    if (stdin.isTTY) stdin.setRawMode(false);
    terminalRestored = true;
  };
  const close = (code = 0) => {
    restoreTerminal();
    process.exit(code);
  };
  const render = () => {
    const cols = stdout.columns || 80;
    if (selected >= agents.length) selected = Math.max(0, agents.length - 1);
    clear();
    stdout.write(`${esc}1mAgent Navigator${esc}0m  ${esc}2mEnter focuses · n/b move · r reload · Esc quits${esc}0m\n\n`);
    if (mode === "error") {
      stdout.write(`${esc}31m${truncateForPanel(message, cols)}${esc}0m\n\n`);
      stdout.write(`${esc}2mPress any key to close.${esc}0m`);
      return;
    }
    if (!agents.length) {
      stdout.write(`${esc}2mNo agents found.${esc}0m`);
      return;
    }
    const max = visibleCount();
    const start = Math.max(0, Math.min(selected - Math.floor(max / 2), agents.length - max));
    const list = agents.slice(start, start + max);
    for (let i = 0; i < list.length; i += 1) {
      const index = start + i;
      const agent = list[i];
      const active = index === selected;
      const style = active ? `${esc}7m` : "";
      const dim = active ? `${esc}7m` : `${esc}2m`;
      const reset = `${esc}0m`;
      const marker = active ? ">" : " ";
      const focused = agent.focused ? " [focused]" : "";
      stdout.write(`${style}${marker} ${truncateForPanel(formatAgent(agent), cols - 4)}${focused}${reset}\n`);
      stdout.write(`${dim}  ${agent.workspace_id || "?"}/${agent.tab_id || "?"}/${agent.pane_id}${reset}\n`);
    }
  };
  const focusSelected = () => {
    const agent = agents[selected];
    if (!agent) return;
    restoreTerminal();
    const result = run(herdrBin(), ["agent", "focus", agent.pane_id]);
    if (!result.ok) {
      process.stderr.write(result.err || result.out || `herdr agent focus failed for ${agent.pane_id}`);
      process.stderr.write("\n");
      process.exit(1);
    }
    process.exit(0);
  };
  const reloadAgents = () => {
    agents = herdrAgentList();
    selected = Math.max(0, agents.findIndex((agent) => agent.focused));
    render();
  };
  const onKey = (buf: Buffer) => {
    const key = buf.toString("utf8");
    if (mode === "error") close(1);
    if (key === "\x03" || key === "\x04" || key === "\x1b") close(0);
    if (key === "\r" || key === "\n") return void focusSelected();
    if (key === "\x1b[B" || key === "\x0e" || key === "n" || key === "j") {
      selected = Math.min(agents.length - 1, selected + 1);
    } else if (key === "\x1b[A" || key === "\x10" || key === "b" || key === "k") {
      selected = Math.max(0, selected - 1);
    } else if (key === "r") {
      return void reloadAgents();
    }
    render();
  };

  if (!stdin.isTTY || !stdout.isTTY) {
    die("agent-panel needs a TTY");
  }

  stdout.write("\x1b[?1049h\x1b[?25l");
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onKey);
  process.on("SIGWINCH", render);
  render();
}

async function main(): Promise<void> {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    die(error.message);
  }

  if (args.command === "create") {
    createCommand(args);
  } else if (args.command === "create-panel") {
    createPanelCommand(args);
  } else if (args.command === "create-branch-panel") {
    createBranchPanelCommand(args);
  } else if (args.command === "archive-panel") {
    archivePanelCommand(args);
  } else if (args.command === "agent-panel") {
    agentPanelCommand();
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
