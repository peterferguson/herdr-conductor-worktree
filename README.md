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

## Current Conductor Discovery Result

Not tested yet. The first trial should create a workspace and then check whether
Conductor auto-discovers externally-created Git worktrees under
`~/conductor/workspaces`.
