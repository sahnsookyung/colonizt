CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  country_code TEXT,
  banned_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  host_user_id TEXT NOT NULL,
  settings_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS room_seats (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seat_index INTEGER NOT NULL,
  user_id TEXT,
  bot_id TEXT,
  ready BOOLEAN NOT NULL DEFAULT false,
  connected BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (room_id, seat_index)
);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  room_id TEXT REFERENCES rooms(id),
  mode TEXT NOT NULL,
  ranked BOOLEAN NOT NULL DEFAULT false,
  seed_hash TEXT NOT NULL,
  config_json JSONB NOT NULL,
  board_json JSONB NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  winner_user_id TEXT
);

CREATE TABLE IF NOT EXISTS match_players (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  seat_index INTEGER NOT NULL,
  rating_before INTEGER,
  rating_after INTEGER,
  result_rank INTEGER,
  PRIMARY KEY (match_id, user_id)
);

CREATE TABLE IF NOT EXISTS match_events (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, seq)
);

CREATE TABLE IF NOT EXISTS match_snapshots (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  state_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, seq)
);

CREATE TABLE IF NOT EXISTS ratings (
  user_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  season_id TEXT NOT NULL,
  rating INTEGER NOT NULL,
  uncertainty INTEGER NOT NULL,
  games_played INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, mode, season_id)
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  match_id TEXT REFERENCES matches(id),
  user_id TEXT NOT NULL,
  message TEXT NOT NULL,
  moderation_status TEXT NOT NULL DEFAULT 'VISIBLE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporter_user_id TEXT NOT NULL,
  reported_user_id TEXT NOT NULL,
  match_id TEXT REFERENCES matches(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  match_id TEXT,
  event_name TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rooms_status_created ON rooms(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_started ON matches(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_match_events_match_seq ON match_events(match_id, seq);
CREATE INDEX IF NOT EXISTS idx_ratings_leaderboard ON ratings(mode, season_id, rating DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_event_name ON analytics_events(event_name, created_at DESC);
