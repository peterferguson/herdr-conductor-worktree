# ADR 0001: Conductor Workspace Registration Model

## Status

Accepted as current working knowledge.

## Date

2026-06-27

## Context

This plugin creates Herdr worktrees at Conductor-compatible paths:

```text
~/conductor/workspaces/<repo-name>/<workspace-name>
```

The first implementation proved that this is enough for Git and Herdr, but not
enough for Conductor. A Herdr-created worktree under the Conductor workspace
directory did not appear in Conductor after launching/focusing the app.

We then captured a before/after snapshot around a workspace created by
Conductor itself. The concrete local values below are anonymized examples from
that probe:

```text
repo root: /path/to/repos/example-repo
workspace directory: trial-workspace
branch: user/trial-workspace
workspace path: /path/to/conductor/workspaces/example-repo/trial-workspace
Conductor version: 0.69.1
```

Snapshot artifacts:

```text
/tmp/conductor-diff-before-<timestamp>
/tmp/conductor-diff-after-<timestamp>
```

The versioned schema snapshot for this probe is:

```text
docs/conductor/conductor-0.69.1-2026-06-27-schema.md
```

Conductor durable state was observed in:

```text
~/Library/Application Support/com.conductor.app/conductor.db
```

Derived local cache files were observed under:

```text
~/Library/Application Support/com.conductor.app/local-storage.entries/
```

## Decision

Treat Conductor workspace registration as a database-backed import, not as
filesystem auto-discovery.

For an already-known Conductor repo, the minimum registration model appears to
be:

1. A real Git worktree exists at the desired Conductor workspace path.
2. One `workspaces` row exists for the worktree.
3. One `sessions` row exists for the workspace.
4. `workspaces.active_session_id` points to that session.

The two local-storage JSON files created for the workspace appear to be derived
cache and should not be treated as authoritative input:

```text
local-storage.entries/git-service-pr-v1/<workspace-id>.json
local-storage.entries/git-service-workspace-changes-v1/<workspace-id>.json
```

For a repo that is not yet known to Conductor, the plugin must also create or
discover a valid `repos` row before registering a workspace.

## Observed Rows

Conductor reused an existing repo row:

```text
id: 11111111-1111-4111-8111-111111111111
name: example-repo
root_path: /path/to/repos/example-repo
remote_url: https://github.com/example/example-repo.git
default_branch: develop
remote: origin
storage_version: 3
```

Conductor inserted one workspace row:

```text
id: 22222222-2222-4222-8222-222222222222
repository_id: 11111111-1111-4111-8111-111111111111
directory_name: trial-workspace
active_session_id: 33333333-3333-4333-8333-333333333333
branch: user/trial-workspace
placeholder_branch_name: user/trial-workspace
state: ready
initialization_parent_branch: develop
initialization_files_copied: 5640
intended_target_branch: develop
derived_status: in-progress
workspace_path: /path/to/conductor/workspaces/example-repo/trial-workspace
permission_level: write
creator_client_id: 44444444-4444-4444-8444-444444444444
```

Conductor inserted one session row:

```text
id: 33333333-3333-4333-8333-333333333333
status: idle
model: opus-4-8-1m
permission_mode: plan
workspace_id: 22222222-2222-4222-8222-222222222222
is_hidden: 0
agent_type: claude
title: Untitled
codex_thinking_level: high
fast_mode: 0
agent_personality: pragmatic
claude_effort_level: medium
feed_offset: -1
```

No new `repos` row was inserted during the probe, because the repo
already existed in Conductor.

## Archive Behavior

We archived the `user/trial-workspace` workspace in Conductor and captured focused
snapshots:

```text
/tmp/conductor-archive-before-trial-workspace-<timestamp>
/tmp/conductor-archive-after-trial-workspace-<timestamp>
```

Observed archive effects:

- The workspace directory was removed from disk:
  `/path/to/conductor/workspaces/example-repo/trial-workspace`.
- The Git worktree entry was removed from `git worktree list`.
- The local branch `refs/heads/user/trial-workspace` was deleted. This matches the
  observed setting `delete_branch_on_archive = true`.
- The `workspaces` row remained.
- The `sessions` row remained unchanged.
- `workspaces.state` changed from `ready` to `archived`.
- `workspaces.archive_commit` was set to the archived worktree HEAD:
  `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`.
- `workspaces.updated_at` did not change in this probe.
- PR cache content was unchanged.
- Workspace-changes cache content only changed `refreshedAt`.

Focused workspace row diff:

```diff
- archive_commit: null
+ archive_commit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
- state: ready
+ state: archived
```

## Compatibility Notes

After a later restart, Conductor reported app version `0.70.0` with migration
`114`:

```text
114 track owning organization for cloud workspaces
```

That migration adds nullable `workspaces.organization_id` and an index. The
existing registration fields used by this plugin are unchanged, so the plugin
treats `0.70.0` / migration `114` as compatible with the `0.69.1` / migration
`113` baseline.

Conductor did not display a directly inserted workspace until the app was
restarted. Treat this as expected behavior for now: direct database writes are
valid durable state, but Conductor does not appear to live-reload all workspace
list state from SQLite.

## Implementation Guidance

When adding registration support to this plugin:

- Keep direct Conductor registration behind an explicit opt-in command or flag,
  for example `--register-conductor`.
- Before modifying `conductor.db`, create a timestamped SQLite backup.
- Prefer a transaction that inserts `sessions`, inserts `workspaces`, and then
  verifies both rows.
- Use generated UUIDs for workspace/session IDs.
- Resolve `creator_client_id` from `settings.key = 'client_instance_id'`.
- Resolve branch prefix from Conductor settings when possible:
  `branch_prefix_custom` with `branch_prefix_type = 'custom'`.
- Resolve default/target branch from the matching `repos.default_branch`, not
  from a hardcoded `main`.
- Create the Git worktree before inserting the Conductor rows.
- Do not pre-create local-storage cache files unless a later probe proves this
  is required.
- Tell users to restart Conductor if the workspace does not appear immediately.
  The CLI may offer an explicit restart flag, but should not restart Conductor
  by default.

When adding archive support to this plugin:

- Capture the worktree HEAD before removing the worktree.
- Remove the Git worktree.
- Delete the local branch only when Conductor's `delete_branch_on_archive`
  setting is true.
- Preserve the `workspaces` and `sessions` rows.
- Update `workspaces.state` to `archived`.
- Set `workspaces.archive_commit` to the captured HEAD.
- Do not delete local-storage cache files unless a later probe proves Conductor
  does so in another scenario.

For new repos, the likely minimum `repos` fields are:

```text
id
remote_url
name
default_branch
root_path
storage_version = 3
display_order
run_script_mode = concurrent
remote = origin
hidden = 0
spotlight_testing = 0
```

This has not yet been tested for a repo that is absent from Conductor.

## Update Triggers

Re-run the before/after probe and update this ADR when any of these change:

- Conductor app version changes from `0.69.1`.
- `conductor.db` schema changes.
- Conductor starts auto-discovering external worktrees.
- Conductor exposes a public import/API/CLI path for registering workspaces.
- The plugin starts supporting repos that are not already present in Conductor.
- Conductor stops regenerating local-storage cache files from DB and Git state.

## Consequences

This gives the plugin a feasible path to full Conductor visibility, but it uses
private app state. The integration must therefore be defensive, version-aware,
and easy to disable. If Conductor later exposes a supported import API, the
plugin should prefer that over SQLite writes.
