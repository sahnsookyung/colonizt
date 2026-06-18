ALTER TABLE rooms ADD COLUMN IF NOT EXISTS room_code TEXT;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS empty_since TIMESTAMPTZ;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS cleanup_reason TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_room_code_unique
  ON rooms(room_code)
  WHERE room_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_rooms_active_lifecycle
  ON rooms(status, archived_at, last_activity_at DESC);
