#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const TAG = "[conductor-worktree]";

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
    slug: undefined,
    conductorRoot: process.env.CONDUCTOR_WORKTREE_ROOT || "~/conductor/workspaces",
    dryRun: false,
  };

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--cwd") {
      args.cwd = argv[++i];
    } else if (arg === "--slug") {
      args.slug = argv[++i];
    } else if (arg === "--conductor-root") {
      args.conductorRoot = argv[++i];
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (args.command !== "create") {
    throw new Error("usage: index.mjs create [--cwd PATH] [--slug NAME] [--conductor-root PATH] [--dry-run]");
  }
  return args;
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

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    die(error.message);
  }

  const repo = repoRoot(resolve(sourceCwd(args.cwd)));
  const slug = slugify(args.slug || timestampSlug());
  const prefix = readConductorBranchPrefix();
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
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
