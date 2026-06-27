# Herdr Conductor Worktree

Create Herdr worktrees under Conductor's normal workspace directory layout:

```text
~/conductor/workspaces/<repo>/<workspace>
```

The plugin calls Herdr's own `worktree create --path` command, so Herdr owns the
created worktree while the checkout lands where Conductor normally stores
workspace checkouts.

## Install

```bash
herdr plugin link /Users/peterferguson/repos/herdr-plugins/herdr-conductor-worktree
```

## Use

From a Herdr pane inside a Git repository:

```bash
herdr plugin action invoke peter.conductor-worktree.create
```

For a terminal trial without relying on Herdr pane context:

```bash
node index.mjs create --cwd /path/to/repo --slug herdr-test
```

The plugin reads `~/.conductor/settings.toml` and uses `[git].branch_prefix`
when present. It refuses to overwrite an existing target directory or existing
local branch.

## Development

```bash
npm test
```

Architecture notes live in [docs/adr](docs/adr/), starting with
[ADR 0001: Conductor Workspace Registration Model](docs/adr/0001-conductor-workspace-registration.md).

## Current Conductor Discovery Result

Tested on 2026-06-27 with:

```bash
node index.mjs create \
  --cwd /Users/peterferguson/repos/herdr-plugins/herdr-conductor-worktree \
  --slug herdr-conductor-trial-20260627
```

Result:

- Herdr created workspace `w4`.
- Git registered a linked worktree at
  `/Users/peterferguson/conductor/workspaces/herdr-conductor-worktree/herdr-conductor-trial-20260627`.
- Conductor did not auto-register the repo or workspace in
  `~/Library/Application Support/com.conductor.app/conductor.db`, even after
  launching/focusing Conductor.

Conclusion: this plugin can create Conductor-shaped worktrees on disk, but
Conductor does not appear to auto-discover externally-created worktrees as
first-class app workspaces.
