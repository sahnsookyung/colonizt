ALTER TABLE rooms ADD COLUMN IF NOT EXISTS pause_reason TEXT;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS trade_deadlines_json JSONB;

CREATE TABLE IF NOT EXISTS room_leases (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rooms_pause_reason
  ON rooms(pause_reason, paused_at DESC)
  WHERE pause_reason IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_room_leases_owner_expires
  ON room_leases(owner_id, expires_at);
