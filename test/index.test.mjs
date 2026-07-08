import test from "node:test";
import assert from "node:assert/strict";
import {
  assertConductorCompatibility,
  buildConductorArchiveSql,
  buildConductorRegistrationSql,
  buildSyncCandidates,
  chooseConductorRepo,
  conductorPath,
  expandHome,
  parseArgs,
  parseBranchPrefix,
  parseConductorSettings,
  parseConductorVersion,
  planConductorSync,
  slugify,
  timestampSlug,
} from "../dist/index.js";

test("slugify normalizes names for branch and path usage", () => {
  assert.equal(slugify("  My Feature / V2!  "), "my-feature-v2");
  assert.equal(slugify("___"), "workspace");
});

test("timestampSlug uses stable local timestamp formatting", () => {
  assert.equal(timestampSlug(new Date(2026, 5, 27, 9, 4, 5)), "herdr-test-20260627-090405");
});

test("parseBranchPrefix reads Conductor branch prefix", () => {
  const toml = `
[git]
branch_prefix = "user/"
branch_prefix_type = "custom"
`;
  assert.equal(parseBranchPrefix(toml), "user/");
  assert.equal(parseBranchPrefix("[git]\narchive_on_merge = false\n"), "");
});

test("conductorPath places workspace under repo-named Conductor directory", () => {
  const path = conductorPath("/path/to/repos/example", "trial", "/tmp/conductor/workspaces");
  assert.equal(path, "/tmp/conductor/workspaces/example/trial");
});

test("expandHome expands tilde paths", () => {
  assert.match(expandHome("~/conductor/workspaces"), /\/conductor\/workspaces$/);
  assert.equal(expandHome("/tmp/x"), "/tmp/x");
});

test("parseArgs supports explicit trial parameters", () => {
  const args = parseArgs([
    "create",
    "--cwd",
    "/repo",
    "--slug",
    "Trial",
    "--dry-run",
    "--register-conductor",
    "--restart-conductor",
  ]);
  assert.equal(args.command, "create");
  assert.equal(args.cwd, "/repo");
  assert.equal(args.slug, "Trial");
  assert.equal(args.conductorRoot, "~/conductor/workspaces");
  assert.equal(args.dryRun, true);
  assert.equal(args.registerConductor, true);
  assert.equal(args.restartConductor, true);
});

test("parseArgs supports archive selectors", () => {
  const args = parseArgs(["archive", "--workspace-id", "workspace-1", "--force", "--herdr-workspace-id", "w1"]);
  assert.equal(args.command, "archive");
  assert.equal(args.workspaceId, "workspace-1");
  assert.equal(args.force, true);
  assert.equal(args.herdrWorkspaceId, "w1");
  assert.throws(() => parseArgs(["archive"]), /archive requires/);
});

test("parseArgs supports panel commands", () => {
  assert.equal(parseArgs(["create-panel"]).command, "create-panel");
  assert.equal(parseArgs(["create-panel"]).registerConductor, true);
  assert.equal(parseArgs(["archive-panel"]).command, "archive-panel");
  assert.equal(parseArgs(["agent-panel"]).command, "agent-panel");
});

test("parseArgs supports Conductor sync flags", () => {
  const args = parseArgs(["sync-from-conductor", "--interactive", "--open-new", "--remove-archived"]);
  assert.equal(args.command, "sync-from-conductor");
  assert.equal(args.interactive, true);
  assert.equal(args.openNew, true);
  assert.equal(args.removeArchived, true);
});

test("parseConductorVersion trims plutil output", () => {
  assert.equal(parseConductorVersion("0.69.1\n"), "0.69.1");
});

test("assertConductorCompatibility fails closed unless unsafe override is passed", () => {
  assert.doesNotThrow(() =>
    assertConductorCompatibility({ appVersion: "0.69.1", migrationMax: 113, unsafe: false }),
  );
  assert.doesNotThrow(() =>
    assertConductorCompatibility({ appVersion: "0.70.0", migrationMax: 114, unsafe: false }),
  );
  assert.doesNotThrow(() =>
    assertConductorCompatibility({ appVersion: "0.71.1", migrationMax: 114, unsafe: false }),
  );
  assert.doesNotThrow(() =>
    assertConductorCompatibility({ appVersion: "0.72.0", migrationMax: 115, unsafe: false }),
  );
  assert.doesNotThrow(() =>
    assertConductorCompatibility({ appVersion: "0.73.0", migrationMax: 115, unsafe: false }),
  );
  assert.throws(
    () => assertConductorCompatibility({ appVersion: "0.73.1", migrationMax: 115, unsafe: false }),
    /unsupported Conductor state/,
  );
  assert.doesNotThrow(() =>
    assertConductorCompatibility({ appVersion: "0.73.1", migrationMax: 115, unsafe: true }),
  );
});

test("parseConductorSettings normalizes settings rows", () => {
  assert.deepEqual(
    parseConductorSettings([
      { key: "client_instance_id", value: "client-1" },
      { key: "branch_prefix_type", value: "custom" },
      { key: "branch_prefix_custom", value: "user/" },
      { key: "delete_branch_on_archive", value: "true" },
    ]),
    {
      clientInstanceId: "client-1",
      branchPrefixType: "custom",
      branchPrefixCustom: "user/",
      deleteBranchOnArchive: true,
    },
  );
});

test("chooseConductorRepo prefers exact repo name when roots are duplicated", () => {
  const rows = [
    { id: "repo-1", name: "example-v1", root_path: "/path/to/repos/example" },
    { id: "repo-2", name: "example", root_path: "/path/to/repos/example" },
  ];
  assert.equal(chooseConductorRepo(rows, "/path/to/repos/example").id, "repo-2");
  assert.equal(chooseConductorRepo(rows, "/path/to/repos/example", "repo-1").id, "repo-1");
});

test("chooseConductorRepo errors for unknown or ambiguous repos", () => {
  assert.throws(() => chooseConductorRepo([], "/repo"), /not registered/);
  assert.throws(
    () =>
      chooseConductorRepo(
        [
          { id: "repo-1", name: "one", root_path: "/repo" },
          { id: "repo-2", name: "two", root_path: "/repo" },
        ],
        "/repo",
      ),
    /multiple Conductor repo rows/,
  );
});

test("buildConductorRegistrationSql inserts sessions then workspaces transactionally", () => {
  const sql = buildConductorRegistrationSql({
    session: {
      id: "session-1",
      status: "idle",
      model: "opus-4-8-1m",
      permission_mode: "plan",
      workspace_id: "workspace-1",
      is_hidden: 0,
    },
    workspace: {
      id: "workspace-1",
      repository_id: "repo-1",
      directory_name: "trial",
      active_session_id: "session-1",
      branch: "user/trial",
      workspace_path: "/tmp/trial",
      creator_client_id: "client-1",
    },
  });
  assert.match(sql, /^begin;/);
  assert.match(sql, /insert into sessions/);
  assert.match(sql, /insert into workspaces/);
  assert.match(sql, /'user\/trial'/);
  assert.match(sql, /commit;$/);
});

test("buildConductorArchiveSql records archived state and commit", () => {
  const sql = buildConductorArchiveSql({
    workspaceId: "workspace-1",
    archiveCommit: "abc123",
  });
  assert.match(sql, /update workspaces set state = 'archived', archive_commit = 'abc123'/);
  assert.match(sql, /where id = 'workspace-1'/);
});

test("planConductorSync finds new Conductor workspaces and archived Herdr workspaces", () => {
  const plan = planConductorSync({
    conductorRoot: "/conductor/workspaces",
    conductorWorkspaces: [
      {
        id: "new-1",
        repo_name: "repo",
        repo_root: "/repos/repo",
        directory_name: "new-workspace",
        branch: "user/new-workspace",
        state: "ready",
        updated_at: "2026-06-27 12:00:00",
        workspace_path: "/conductor/workspaces/repo/new-workspace",
      },
      {
        id: "archived-1",
        repo_name: "repo",
        repo_root: "/repos/repo",
        directory_name: "old-workspace",
        branch: "user/old-workspace",
        state: "archived",
        updated_at: "2026-06-27 11:00:00",
        workspace_path: "/conductor/workspaces/repo/old-workspace",
      },
      {
        id: "already-open",
        repo_name: "repo",
        repo_root: "/repos/repo",
        directory_name: "open-workspace",
        branch: "user/open-workspace",
        state: "ready",
        updated_at: "2026-06-27 10:00:00",
        workspace_path: "/conductor/workspaces/repo/open-workspace",
      },
      {
        id: "outside-root",
        repo_name: "repo",
        repo_root: "/repos/repo",
        directory_name: "remote",
        branch: "user/remote",
        state: "ready",
        updated_at: "2026-06-27 13:00:00",
        workspace_path: "/conductor/remote-workspace-sync/repo/remote",
      },
    ],
    herdrWorkspaces: [
      {
        workspace_id: "w-old",
        worktree: {
          checkout_path: "/conductor/workspaces/repo/old-workspace",
        },
      },
      {
        workspace_id: "w-open",
        worktree: {
          checkout_path: "/conductor/workspaces/repo/open-workspace",
        },
      },
    ],
  });

  assert.deepEqual(
    plan.newConductorWorkspaces.map((workspace) => workspace.id),
    ["new-1"],
  );
  assert.deepEqual(
    plan.archivedHerdrWorkspaces.map((workspace) => workspace.id),
    ["archived-1"],
  );
  assert.equal(plan.archivedHerdrWorkspaces[0].herdrWorkspace.workspace_id, "w-old");
});

test("buildSyncCandidates creates open and remove actions", () => {
  const candidates = buildSyncCandidates({
    newConductorWorkspaces: [{ id: "new-1" }],
    archivedHerdrWorkspaces: [{ id: "archived-1" }],
  });

  assert.deepEqual(
    candidates.map((candidate) => [candidate.action, candidate.workspace.id]),
    [
      ["open", "new-1"],
      ["remove", "archived-1"],
    ],
  );
});

test("planConductorSync preserves Conductor updated order", () => {
  const plan = planConductorSync({
    conductorRoot: "/conductor/workspaces",
    conductorWorkspaces: [
      {
        id: "newest",
        repo_name: "repo",
        repo_root: "/repos/repo",
        directory_name: "newest",
        branch: "user/newest",
        state: "ready",
        updated_at: "2026-06-27 13:00:00",
        workspace_path: "/conductor/workspaces/repo/newest",
      },
      {
        id: "older",
        repo_name: "repo",
        repo_root: "/repos/repo",
        directory_name: "older",
        branch: "user/older",
        state: "ready",
        updated_at: "2026-06-27 12:00:00",
        workspace_path: "/conductor/workspaces/repo/older",
      },
    ],
    herdrWorkspaces: [],
  });

  assert.deepEqual(
    plan.newConductorWorkspaces.map((workspace) => workspace.id),
    ["newest", "older"],
  );
});
