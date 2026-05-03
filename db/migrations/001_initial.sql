PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS worlds (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  title_status TEXT NOT NULL DEFAULT 'provisional',
  title_source TEXT NOT NULL DEFAULT 'seed',
  title_locked INTEGER NOT NULL DEFAULT 0,
  subtitle TEXT,
  title_updated_at TEXT,
  seed_text TEXT NOT NULL,
  random_seed_enabled INTEGER NOT NULL,
  random_seed_value TEXT,
  cg_style_prompt TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  webgpt_session_url TEXT,
  cg_webgpt_conversation_id TEXT,
  auto_cg_enabled INTEGER NOT NULL DEFAULT 1,
  narrative_level INTEGER NOT NULL DEFAULT 2,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  active_turn_id TEXT
);

CREATE TABLE IF NOT EXISTS raw_submissions (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS player_actions (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL,
  player_action_id TEXT REFERENCES player_actions(id),
  raw_submission_id TEXT NOT NULL REFERENCES raw_submissions(id),
  display_shape_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, turn_index)
);

CREATE TABLE IF NOT EXISTS displayability_warnings (
  id TEXT PRIMARY KEY,
  turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE,
  raw_submission_id TEXT REFERENCES raw_submissions(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  path TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS world_title_proposals (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
  candidate TEXT NOT NULL,
  subtitle TEXT,
  reason TEXT,
  confidence REAL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webgpt_dispatches (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  conversation_id TEXT,
  dispatch_token_hash TEXT,
  payload_json TEXT NOT NULL,
  result_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS saves (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS library_docs (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS library_doc_versions (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES library_docs(id) ON DELETE CASCADE,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body_json TEXT NOT NULL,
  visible_to_llm INTEGER NOT NULL,
  visible_to_player INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  source_turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
  update_reason TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS library_doc_usage (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  doc_id TEXT NOT NULL REFERENCES library_docs(id) ON DELETE CASCADE,
  last_used_turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
  last_used_turn_index INTEGER,
  last_touched_turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
  last_touched_turn_index INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (world_id, session_id, doc_id)
);

CREATE TABLE IF NOT EXISTS turn_doc_links (
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  doc_version_id TEXT NOT NULL REFERENCES library_doc_versions(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (turn_id, doc_version_id)
);

CREATE TABLE IF NOT EXISTS cg_assets (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  job_id TEXT,
  status TEXT NOT NULL,
  prompt TEXT NOT NULL,
  negative_prompt TEXT,
  image_url TEXT,
  alt_text TEXT,
  provider TEXT,
  generated_by_lane TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(turn_id)
);

CREATE TABLE IF NOT EXISTS cg_reference_boards (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  image_url TEXT,
  pinned INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webgpt_jobs (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  lane TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL,
  target_turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE,
  conversation_id TEXT,
  payload_json TEXT NOT NULL,
  result_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS library_doc_pins (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  doc_id TEXT NOT NULL REFERENCES library_docs(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (world_id, session_id, doc_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_world_id ON sessions(world_id);
CREATE INDEX IF NOT EXISTS idx_turns_session_index ON turns(session_id, turn_index);
CREATE INDEX IF NOT EXISTS idx_actions_session_created ON player_actions(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_saves_session_created ON saves(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_world_title_proposals_world ON world_title_proposals(world_id, created_at);
CREATE INDEX IF NOT EXISTS idx_doc_versions_world_created ON library_doc_versions(world_id, created_at);
CREATE INDEX IF NOT EXISTS idx_doc_pins_world_session ON library_doc_pins(world_id, session_id);
CREATE INDEX IF NOT EXISTS idx_doc_usage_world_session ON library_doc_usage(world_id, session_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_cg_assets_session_turn ON cg_assets(session_id, turn_id);
CREATE INDEX IF NOT EXISTS idx_cg_reference_boards_world ON cg_reference_boards(world_id, pinned, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_webgpt_jobs_lane_status ON webgpt_jobs(lane, status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_webgpt_jobs_session ON webgpt_jobs(world_id, session_id, status, created_at);
