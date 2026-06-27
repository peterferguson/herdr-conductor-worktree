# Conductor 0.69.1 Schema Snapshot

Captured on 2026-06-27 from:

```text
app: /Applications/Conductor.app
version: 0.69.1
database: ~/Library/Application Support/com.conductor.app/conductor.db
max migration: 113
migration count: 113
```

This snapshot intentionally captures only the schema and settings relevant to
workspace registration for this plugin. Re-capture when Conductor changes
version or when registration behavior changes.

## Relevant Settings

Observed values at capture time:

```text
branch_prefix_type: custom
branch_prefix_custom: peter/
client_instance_id: cc11422c-dbd8-4f67-b929-82dced9261bb
delete_branch_on_archive: true
```

## Recent Migrations

```text
113 preserve Cursor Composer fast default
112 track which client created each workspace
111 add deprecated_at to settings for file-backed migration
110 track remote workspace file sync intent
109 migrate deprecated codex models to gpt-5.5
108 remove deprecated cloud workspaces setting
107 add spotlight testing setting to repos
106 track remote workspace creators
105 add workspace permission level
104 track user-set workspace and branch names
103 set new installs default model to gpt-5.5
102 create env_vars table
```

## `repos`

```sql
CREATE TABLE repos (
                    id TEXT PRIMARY KEY,
                    remote_url TEXT,
                    name TEXT,
                    default_branch TEXT DEFAULT 'main',
                    root_path TEXT,
                    setup_script TEXT,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                , storage_version INTEGER DEFAULT 1, archive_script TEXT, display_order INTEGER DEFAULT 0, run_script TEXT, run_script_mode TEXT DEFAULT 'concurrent', remote TEXT, custom_prompt_code_review TEXT, custom_prompt_create_pr TEXT, custom_prompt_rename_branch TEXT, conductor_config TEXT, custom_prompt_general TEXT, icon TEXT, hidden INTEGER DEFAULT 0, custom_prompt_fix_errors TEXT, custom_prompt_resolve_merge_conflicts TEXT, file_include_globs TEXT, spotlight_testing INTEGER DEFAULT 0);

CREATE TRIGGER update_repos_updated_at
                AFTER UPDATE ON repos
                BEGIN
                    UPDATE repos SET updated_at = datetime('now')
                    WHERE id = NEW.id;
                END;
```

## `workspaces`

```sql
CREATE TABLE workspaces (
                    id TEXT PRIMARY KEY,
                    repository_id TEXT,
                    DEPRECATED_city_name TEXT,
                    directory_name TEXT,
                    DEPRECATED_archived INTEGER DEFAULT 0,
                    active_session_id TEXT,
                    branch TEXT,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                , unread INTEGER DEFAULT 0, placeholder_branch_name TEXT, state TEXT DEFAULT 'active', initialization_parent_branch TEXT, big_terminal_mode INTEGER DEFAULT 0, setup_log_path TEXT, initialization_log_path TEXT, initialization_files_copied INTEGER, pinned_at TEXT, linked_workspace_ids TEXT, notes TEXT, intended_target_branch TEXT, manual_status TEXT, derived_status TEXT DEFAULT 'in-progress', archive_commit TEXT, pr_title TEXT, pr_description TEXT, secondary_directory_name TEXT, linked_directory_paths TEXT, hosting_server_url TEXT, sandbox_provider TEXT, workspace_path TEXT, user_set_workspace_name INTEGER DEFAULT 0, user_set_branch_name INTEGER DEFAULT 0, workspace_name TEXT, permission_level TEXT, creator_user_id TEXT, remote_file_sync_enabled INTEGER DEFAULT 0, creator_client_id TEXT);

CREATE INDEX idx_workspaces_repository_id ON workspaces(repository_id);
```

Fields used by the current registration hypothesis:

```text
id
repository_id
directory_name
active_session_id
branch
placeholder_branch_name
state
initialization_parent_branch
initialization_log_path
initialization_files_copied
intended_target_branch
derived_status
workspace_path
permission_level
creator_client_id
```

## `sessions`

```sql
CREATE TABLE IF NOT EXISTS "sessions" (
                        id TEXT PRIMARY KEY,
                        status TEXT DEFAULT 'idle',
                        claude_session_id TEXT,
                        unread_count INTEGER DEFAULT 0,
                        freshly_compacted INTEGER DEFAULT 0,
                        context_token_count INTEGER DEFAULT 0,
                        created_at TEXT NOT NULL DEFAULT (datetime('now')),
                        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                    , is_compacting INTEGER DEFAULT 0, model TEXT, permission_mode TEXT DEFAULT 'default', DEPRECATED_thinking_level TEXT DEFAULT 'NONE', last_user_message_at TEXT, resume_session_at TEXT, workspace_id TEXT, is_hidden INTEGER DEFAULT 0, agent_type, title TEXT DEFAULT 'Untitled', context_used_percent FLOAT, DEPRECATED_thinking_enabled INTEGER DEFAULT 1, codex_thinking_level TEXT, fast_mode INTEGER DEFAULT 0, agent_personality TEXT, claude_effort_level TEXT, feed_offset INTEGER, queue_paused_at TEXT);

CREATE TRIGGER update_sessions_updated_at
                    AFTER UPDATE ON sessions
                    BEGIN
                        UPDATE sessions SET updated_at = datetime('now')
                        WHERE id = NEW.id;
                    END;

CREATE INDEX idx_sessions_workspace_id ON sessions(workspace_id);
```

Fields used by the current registration hypothesis:

```text
id
status
model
permission_mode
workspace_id
is_hidden
agent_type
title
codex_thinking_level
fast_mode
agent_personality
claude_effort_level
feed_offset
```

## `settings`

```sql
CREATE TABLE settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                , deprecated_at TEXT);

CREATE TRIGGER update_settings_updated_at
                AFTER UPDATE ON settings
                BEGIN
                    UPDATE settings SET updated_at = datetime('now')
                    WHERE key = NEW.key;
                END;
```

Settings used by this plugin:

```text
branch_prefix_type
branch_prefix_custom
client_instance_id
delete_branch_on_archive
```

## Derived Cache Files

During the `peter/windhoek` probe, Conductor created these files after the
workspace existed:

```text
local-storage.entries/git-service-pr-v1/<workspace-id>.json
local-storage.entries/git-service-workspace-changes-v1/<workspace-id>.json
```

Current assumption: these are regenerated from database rows and Git state, and
the plugin should not write them directly.
