import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  defaultCgStylePrompt,
  legacyRedrawCgStylePrompt,
  misspelledKoreanDefaultCgStylePrompt,
  previousDefaultCgStylePrompt
} from "../../../packages/core/src/index.js";

export function openDatabase(): DatabaseSync {
  const dataDir = process.env.VNPLAYER_DATA_DIR ?? join(process.cwd(), "data");
  const dbPath = process.env.VNPLAYER_DB_PATH ?? join(dataDir, "vnplayer.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");

  const migrationPath = join(process.cwd(), "db", "migrations", "001_initial.sql");
  if (!existsSync(migrationPath)) {
    throw new Error(`마이그레이션 파일을 찾을 수 없습니다: ${migrationPath}`);
  }
  db.exec(readFileSync(migrationPath, "utf8"));
  applyCompatibilityMigrations(db);

  return db;
}

function applyCompatibilityMigrations(db: DatabaseSync): void {
  const addColumn = (sql: string) => {
    try {
      db.exec(sql);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("duplicate column")) {
        throw error;
      }
    }
  };

  try {
    db.exec(`ALTER TABLE worlds ADD COLUMN cg_style_prompt TEXT NOT NULL DEFAULT ${JSON.stringify(defaultCgStylePrompt)};`);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("duplicate column")) {
      throw error;
    }
  }
  db.prepare("UPDATE worlds SET cg_style_prompt = ? WHERE cg_style_prompt = ?").run(defaultCgStylePrompt, legacyRedrawCgStylePrompt);
  db.prepare("UPDATE worlds SET cg_style_prompt = ? WHERE cg_style_prompt = ?").run(defaultCgStylePrompt, previousDefaultCgStylePrompt);
  db.prepare("UPDATE worlds SET cg_style_prompt = ? WHERE cg_style_prompt = ?").run(defaultCgStylePrompt, misspelledKoreanDefaultCgStylePrompt);
  addColumn("ALTER TABLE worlds ADD COLUMN title_status TEXT NOT NULL DEFAULT 'provisional';");
  addColumn("ALTER TABLE worlds ADD COLUMN title_source TEXT NOT NULL DEFAULT 'seed';");
  addColumn("ALTER TABLE worlds ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0;");
  addColumn("ALTER TABLE worlds ADD COLUMN subtitle TEXT;");
  addColumn("ALTER TABLE worlds ADD COLUMN title_updated_at TEXT;");
  addColumn("ALTER TABLE sessions ADD COLUMN cg_webgpt_conversation_id TEXT;");
  addColumn("ALTER TABLE sessions ADD COLUMN auto_cg_enabled INTEGER NOT NULL DEFAULT 1;");
  addColumn("ALTER TABLE sessions ADD COLUMN narrative_level INTEGER NOT NULL DEFAULT 2;");
  addColumn("ALTER TABLE webgpt_dispatches ADD COLUMN dispatch_token_hash TEXT;");
  addColumn("ALTER TABLE library_doc_versions ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';");
  db.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_world_title_proposals_world ON world_title_proposals(world_id, created_at);
    CREATE TABLE IF NOT EXISTS library_doc_pins (
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      doc_id TEXT NOT NULL REFERENCES library_docs(id) ON DELETE CASCADE,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (world_id, session_id, doc_id)
    );
    CREATE INDEX IF NOT EXISTS idx_doc_pins_world_session ON library_doc_pins(world_id, session_id);
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
    CREATE INDEX IF NOT EXISTS idx_doc_usage_world_session ON library_doc_usage(world_id, session_id, updated_at);
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
    CREATE INDEX IF NOT EXISTS idx_cg_assets_session_turn ON cg_assets(session_id, turn_id);
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
    CREATE INDEX IF NOT EXISTS idx_cg_reference_boards_world ON cg_reference_boards(world_id, pinned, status, updated_at);
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
    CREATE INDEX IF NOT EXISTS idx_webgpt_jobs_lane_status ON webgpt_jobs(lane, status, priority, created_at);
    CREATE INDEX IF NOT EXISTS idx_webgpt_jobs_session ON webgpt_jobs(world_id, session_id, status, created_at);
  `);
  db.exec(`
    UPDATE sessions
       SET cg_webgpt_conversation_id = (
         SELECT j.conversation_id
           FROM webgpt_jobs j
          WHERE j.world_id = sessions.world_id
            AND j.session_id = sessions.id
            AND j.lane = 'cg_side'
            AND j.conversation_id IS NOT NULL
            AND j.conversation_id != ''
          ORDER BY COALESCE(j.finished_at, j.started_at, j.created_at) DESC
          LIMIT 1
       )
     WHERE (cg_webgpt_conversation_id IS NULL OR cg_webgpt_conversation_id = '')
       AND EXISTS (
         SELECT 1
           FROM webgpt_jobs j
          WHERE j.world_id = sessions.world_id
            AND j.session_id = sessions.id
            AND j.lane = 'cg_side'
            AND j.conversation_id IS NOT NULL
            AND j.conversation_id != ''
       );
  `);
  for (const column of [
    "ALTER TABLE cg_assets ADD COLUMN job_id TEXT;",
    "ALTER TABLE cg_assets ADD COLUMN generated_by_lane TEXT;",
    "ALTER TABLE cg_reference_boards ADD COLUMN session_id TEXT;"
  ]) {
    addColumn(column);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_cg_reference_boards_scope ON cg_reference_boards(world_id, session_id, kind, pinned, status, updated_at);");
}
