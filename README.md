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
herdr plugin link /path/to/herdr-conductor-worktree
```

## Use

From a Herdr pane inside a Git repository:

```bash
herdr plugin action invoke community.conductor-worktree.create
```

To create the worktree in Herdr and register it in Conductor's private database,
use the explicit both-apps action:

```bash
herdr plugin action invoke community.conductor-worktree.create-both
```

To create a Conductor + Herdr workspace from an existing branch:

```bash
dist/index.js create \
  --cwd /path/to/repo \
  --branch peter/existing-feature \
  --register-conductor
```

The workspace directory defaults to a slug derived from the branch name, for
example `peter-existing-feature`. Pass `--slug NAME` to choose a shorter
workspace directory. If the branch exists only as `origin/<branch>`, the plugin
uses that remote-tracking branch as the base for the local checkout. If no local
or remote branch exists, pass `--base REF` explicitly to create the branch from
that ref.

Bind that action to a simple key in your Herdr config:

```toml
[[keys.command]]
key = "prefix+shift+o"
type = "shell"
command = "/path/to/herdr-conductor-worktree/bin/create-both-visible"
description = "create Conductor + Herdr worktree"

[[keys.command]]
key = "prefix+shift+b"
type = "shell"
command = "/path/to/herdr-conductor-worktree/bin/create-from-branch-visible"
description = "create Conductor + Herdr worktree from branch"

[[keys.command]]
key = "prefix+shift+a"
type = "shell"
command = "/path/to/herdr-conductor-worktree/bin/archive-both-visible"
description = "archive Conductor + Herdr worktree"
```

Then reload Herdr:

```bash
herdr server reload-config
```

`create-both` is an alias for the existing registered create flow:

```bash
herdr plugin action invoke community.conductor-worktree.create-registered
```

To compare Conductor and Herdr state, then choose which Conductor workspaces to
open in Herdr and which archived Conductor workspaces to remove from Herdr:

```bash
herdr plugin action invoke community.conductor-worktree.sync-from-conductor
```

For an interactive keybinding, bind the pane wrapper instead of invoking the
plugin action wrapper. Plugin actions run without an interactive TTY, while
`type = "pane"` gives the sync command a terminal for yes/no prompts:

```toml
[[keys.command]]
key = "prefix+shift+c"
type = "pane"
command = "/path/to/herdr-conductor-worktree/bin/sync-from-conductor-interactive"
```

The interactive sync pane uses a multi-select list:

- `Open in Herdr` actions are green.
- `Remove archived from Herdr` actions are red.
- Repo names are cyan.
- Branch names are yellow.
- Up/Down or `j`/`k`: move
- Space: toggle one item
- `a`: toggle all
- Enter: apply selected actions
- `q`: cancel

For a terminal trial without relying on Herdr pane context:

```bash
dist/index.js create --cwd /path/to/repo --slug herdr-test
```

For an explicit registration trial:

```bash
dist/index.js create \
  --cwd /path/to/repo \
  --slug herdr-test \
  --register-conductor
```

Conductor may not show a directly inserted workspace until the app restarts. To
have the plugin quit and reopen Conductor after a successful registration on
macOS, pass:

```bash
dist/index.js create \
  --cwd /path/to/repo \
  --slug herdr-test \
  --register-conductor \
  --restart-conductor
```

Registration is currently supported only for repos already present in
Conductor. The plugin checks for a known compatible Conductor app/schema
baseline before writing. Current supported baselines are app `0.69.1` with
migration `113`, apps `0.70.0` and `0.71.1` with migration `114`, and app
`0.72.0`, `0.73.0`, `0.73.3`, and `0.74.0` with migration `115`. It
creates a timestamped backup, inserts the `sessions` and `workspaces` rows, and
verifies the rows after writing. The backup first tries SQLite's `.backup`; if
that does not complete quickly, it copies `conductor.db` plus any WAL/SHM
sidecars. If Conductor has changed, the command fails closed unless
`--unsafe-conductor-version` is passed.

Archive a registered workspace from the terminal with one of:

```bash
dist/index.js archive --workspace-id <id>
dist/index.js archive --cwd /path/to/worktree
dist/index.js archive --branch user/herdr-test
```

Archive refuses dirty worktrees unless `--force` is passed. It mirrors the
observed Conductor behavior: capture worktree HEAD, back up the DB, remove the
Git worktree, delete the branch when Conductor's `delete_branch_on_archive`
setting is true, mark the workspace row `archived`, and preserve sessions/cache
files. Pass `--restart-conductor` if Conductor does not show the archived state
until restart.

Sync from Conductor without prompts:

```bash
dist/index.js sync-from-conductor --open-new --remove-archived
```

The sync command reads Conductor `workspaces` rows under
`~/conductor/workspaces`, compares them with `herdr workspace list`, and reports:

- Conductor workspaces in `ready` or `active` state that are not open in Herdr.
- Herdr workspaces whose checkout path points at a Conductor workspace now marked
  `archived`.
- Workspaces are listed newest-first by Conductor `workspaces.updated_at`.

Without `--open-new`, `--remove-archived`, or `--interactive`, it only reports
the differences.

Without `--register-conductor`, the plugin reads `~/.conductor/settings.toml`
and uses `[git].branch_prefix` when present. With registration enabled, it uses
Conductor's `settings` table for the custom branch prefix. In both modes it
refuses to overwrite an existing target directory or existing local branch.

## Development

Requires Node.js 18+ at runtime and Bun for local builds.

```bash
npm run build
npm test
```

The CLI source is TypeScript in [src/index.ts](src/index.ts). `npm run build`
uses Bun to compile it into the executable [dist/index.js](dist/index.js),
which is the entrypoint used by Herdr.

Architecture notes live in [docs/adr](docs/adr/), starting with
[ADR 0001: Conductor Workspace Registration Model](docs/adr/0001-conductor-workspace-registration.md).
The captured Conductor `0.69.1` schema snapshot lives in
[docs/conductor/conductor-0.69.1-2026-06-27-schema.md](docs/conductor/conductor-0.69.1-2026-06-27-schema.md).

## Current Conductor Discovery Result

Tested on 2026-06-27 with:

```bash
dist/index.js create \
  --cwd /path/to/herdr-conductor-worktree \
  --slug trial-workspace
```

Result:

- Herdr created a workspace.
- Git registered a linked worktree at
  `~/conductor/workspaces/herdr-conductor-worktree/trial-workspace`.
- Conductor did not auto-register the repo or workspace in
  `~/Library/Application Support/com.conductor.app/conductor.db`, even after
  launching/focusing Conductor.

Conclusion: this plugin can create Conductor-shaped worktrees on disk, but
Conductor does not appear to auto-discover externally-created worktrees as
first-class app workspaces.
