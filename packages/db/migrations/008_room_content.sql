ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE;

UPDATE chat_messages AS chat
SET room_id = matches.room_id
FROM matches
WHERE chat.room_id IS NULL
  AND chat.match_id = matches.id;

UPDATE reports AS report
SET room_id = matches.room_id
FROM matches
WHERE report.room_id IS NULL
  AND report.match_id = matches.id;

CREATE INDEX IF NOT EXISTS idx_chat_messages_room_created ON chat_messages(room_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_reports_room_status ON reports(room_id, status, created_at ASC);
