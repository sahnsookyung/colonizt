ALTER TABLE rooms ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS command_results (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  match_id TEXT,
  user_id TEXT NOT NULL,
  client_seq INTEGER NOT NULL,
  command_hash TEXT NOT NULL,
  ok BOOLEAN NOT NULL,
  seq_start INTEGER,
  seq_end INTEGER,
  events_json JSONB,
  rejection_code TEXT,
  rejection_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id, client_seq)
);

CREATE INDEX IF NOT EXISTS idx_command_results_match_seq ON command_results(match_id, seq_start, seq_end);
CREATE INDEX IF NOT EXISTS idx_rooms_status_updated ON rooms(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_match_snapshots_desc ON match_snapshots(match_id, seq DESC);
