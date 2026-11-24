/**
 * v0.9 SQLite WAL schema (`vela.db`).
 *
 * Logical boundary:
 * - Platform control-plane tables (`projects`, `sessions`, `channel_bindings`, `inbox_events`,
 *   `runs`, `events`, `approvals`, `outbox`, `timers`, `subscriptions`, `background_jobs`,
 *   `blobs`, `usage_records`, `trusted_paths`, `kv_meta`) are driver-agnostic.
 * - `VelaDriver` private tables (`vela_messages`, `vela_tool_calls`) share the same SQLite
 *   connection for atomic step-level durability without leaking Vela internals into Runtime.
 */

export const SCHEMA_VERSION = 1

export const INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trusted_paths (
  path TEXT PRIMARY KEY NOT NULL,
  trusted INTEGER NOT NULL CHECK (trusted IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  cwd TEXT,
  data_dir TEXT,
  hub_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  default_driver TEXT NOT NULL DEFAULT 'vela',
  default_location_json TEXT,
  default_model TEXT,
  default_thinking_level TEXT,
  default_tools_json TEXT,
  config_json TEXT,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_cwd
  ON projects (cwd);

CREATE INDEX IF NOT EXISTS idx_projects_archived_updated
  ON projects (archived, updated_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'hub', 'topic', 'work')),
  driver TEXT NOT NULL DEFAULT 'vela',
  external_session_id TEXT,
  name TEXT,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  model TEXT,
  thinking_level TEXT,
  location_json TEXT,
  leaf_message_id TEXT,
  discovered_tools_json TEXT,
  parent_session_id TEXT,
  state TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('idle', 'running', 'waiting_human', 'stopped')),
  waiting_reason TEXT,
  followup_streak INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_project_list
  ON sessions (project_id, archived, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_state
  ON sessions (state);

CREATE TABLE IF NOT EXISTS channel_bindings (
  id TEXT PRIMARY KEY NOT NULL,
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  thread_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('group', 'direct')),
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  config_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (channel, external_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_bindings_project
  ON channel_bindings (project_id);

CREATE INDEX IF NOT EXISTS idx_channel_bindings_session
  ON channel_bindings (session_id);

CREATE TABLE IF NOT EXISTS inbox_events (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  dedupe_key TEXT,
  wake INTEGER NOT NULL DEFAULT 1 CHECK (wake IN (0, 1)),
  passive INTEGER NOT NULL DEFAULT 0 CHECK (passive IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'dropped')),
  payload_json TEXT NOT NULL,
  run_id TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_source_dedupe
  ON inbox_events (source, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inbox_session_status
  ON inbox_events (session_id, status, created_at);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  driver TEXT NOT NULL DEFAULT 'vela',
  trigger TEXT NOT NULL CHECK (trigger IN ('user', 'channel', 'timer', 'webhook', 'approval', 'job')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_human', 'completed', 'stopped', 'failed', 'interrupted')),
  model TEXT,
  error TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_session_status
  ON runs (session_id, status);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id TEXT,
  run_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_session_seq
  ON events (session_id, seq);

CREATE INDEX IF NOT EXISTS idx_events_project_seq
  ON events (project_id, seq);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tool_call_id TEXT,
  tool_name TEXT NOT NULL,
  summary TEXT NOT NULL,
  input_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'cancelled')),
  decision_reason TEXT,
  decided_by TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_approvals_session_status
  ON approvals (session_id, status);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT,
  channel TEXT NOT NULL,
  external_chat_id TEXT NOT NULL,
  thread_id TEXT,
  reply_to_message_id TEXT,
  kind TEXT NOT NULL DEFAULT 'reply' CHECK (kind IN ('reply', 'topic_start', 'forward', 'file')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  attempt INTEGER NOT NULL DEFAULT 0,
  external_message_id TEXT,
  last_error TEXT,
  next_retry_at TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outbox_status_retry
  ON outbox (status, next_retry_at);

CREATE TABLE IF NOT EXISTS timers (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('routine', 'followup')),
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  channel TEXT,
  creator_id TEXT,
  creator_name TEXT,
  message TEXT NOT NULL,
  schedule_json TEXT NOT NULL,
  timezone TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  next_fire_at TEXT,
  last_fired_at TEXT,
  schedule_updated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_timers_due
  ON timers (enabled, next_fire_at);

CREATE INDEX IF NOT EXISTS idx_timers_project
  ON timers (project_id);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY NOT NULL,
  source TEXT NOT NULL,
  event_key TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  creator_id TEXT,
  creator_name TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_source_key
  ON subscriptions (source, event_key);

CREATE INDEX IF NOT EXISTS idx_subscriptions_session
  ON subscriptions (session_id);

CREATE TABLE IF NOT EXISTS background_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT,
  command TEXT NOT NULL,
  command_head TEXT NOT NULL,
  location_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'stopped', 'interrupted')),
  exit_code INTEGER,
  output_path TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bg_jobs_session_status
  ON background_jobs (session_id, status);

CREATE TABLE IF NOT EXISTS blobs (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  message_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blobs_session
  ON blobs (session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_blobs_sha256
  ON blobs (sha256);

CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  run_id TEXT,
  message_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('main', 'summary', 'dream')),
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  duration_ms INTEGER,
  raw_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_session
  ON usage_records (session_id, created_at);

-- VelaDriver private step-durable tables

CREATE TABLE IF NOT EXISTS vela_messages (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  parent_id TEXT,
  seq INTEGER NOT NULL,
  run_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'compaction', 'branch_summary', 'bash_execution', 'custom_message', 'custom', 'context_edit')),
  role TEXT,
  content_json TEXT NOT NULL,
  include_in_context INTEGER NOT NULL DEFAULT 1 CHECK (include_in_context IN (0, 1)),
  stop_reason TEXT,
  produced_by TEXT,
  first_kept_id TEXT,
  tokens_before INTEGER,
  label TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  cost_usd REAL,
  duration_ms INTEGER,
  details_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_vela_messages_parent
  ON vela_messages (session_id, parent_id);

CREATE TABLE IF NOT EXISTS vela_tool_calls (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  assistant_message_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  call_index INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  input_json TEXT NOT NULL,
  execution_mode TEXT NOT NULL DEFAULT 'sequential' CHECK (execution_mode IN ('parallel', 'sequential')),
  replay TEXT NOT NULL DEFAULT 'none' CHECK (replay IN ('safe', 'none')),
  location_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'awaiting_approval', 'completed', 'failed', 'skipped', 'interrupted')),
  attempt INTEGER NOT NULL DEFAULT 0,
  is_error INTEGER NOT NULL DEFAULT 0 CHECK (is_error IN (0, 1)),
  preview TEXT,
  result_json TEXT,
  spill_path TEXT,
  details_json TEXT,
  duration_ms INTEGER,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, tool_call_id)
);

CREATE INDEX IF NOT EXISTS idx_vela_tool_calls_status
  ON vela_tool_calls (session_id, status);

CREATE INDEX IF NOT EXISTS idx_vela_tool_calls_msg
  ON vela_tool_calls (session_id, assistant_message_id, call_index);
`
