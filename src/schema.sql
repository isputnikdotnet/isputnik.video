-- The video engine's catalog. Home owns which libraries exist and who may see
-- them; this database owns what is in them (home's docs/video-architecture.md).
-- Idempotent: applied on every open (db.ts).

-- A library as home told us about it. `id` is home's libraries.id. A library
-- home stops listing is `detached`, never dropped on sync, so restoring an older
-- home backup cannot wipe newer data; only an explicit delete from home removes it.
CREATE TABLE IF NOT EXISTS libraries (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('shows', 'movies')),
  -- Relative to MEDIA_ROOT, forward slashes, no leading slash ("Shows").
  folder          TEXT NOT NULL,
  language        TEXT NOT NULL DEFAULT 'en',
  state           TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'detached')),
  detached_at     TEXT,
  scan_state      TEXT NOT NULL DEFAULT 'idle' CHECK (scan_state IN ('idle', 'queued', 'scanning', 'error')),
  scan_error      TEXT,
  last_scan_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A show: one top-level folder of a shows library. Ids stay the same across
-- rescans (found again by library + folder), because home's tags point at them.
CREATE TABLE IF NOT EXISTS shows (
  id            TEXT PRIMARY KEY,
  library_id    TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  folder        TEXT NOT NULL,
  title         TEXT NOT NULL,
  sort_title    TEXT NOT NULL,
  original_title TEXT,
  year          INTEGER,
  plot          TEXT,
  premiered     TEXT,
  status        TEXT,
  genres        TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings
  imdb_id       TEXT,
  tmdb_id       TEXT,
  -- 'nfo' when tvshow.nfo described it, 'folder' when only its name did.
  source        TEXT NOT NULL DEFAULT 'folder' CHECK (source IN ('folder', 'nfo')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (library_id, folder)
);

CREATE TABLE IF NOT EXISTS episodes (
  id              TEXT PRIMARY KEY,
  show_id         TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  season          INTEGER NOT NULL,
  episode         INTEGER NOT NULL,
  -- Relative to the show's folder.
  file            TEXT NOT NULL,
  title           TEXT,
  plot            TEXT,
  aired           TEXT,
  runtime_minutes INTEGER,
  size_bytes      INTEGER NOT NULL DEFAULT 0,
  modified_at     TEXT,
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (show_id, file)
);
CREATE INDEX IF NOT EXISTS episodes_order ON episodes (show_id, season, episode);

-- A movie: one top-level folder (or a loose file) of a movies library.
CREATE TABLE IF NOT EXISTS movies (
  id            TEXT PRIMARY KEY,
  library_id    TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  -- Relative to the library folder: the movie's folder, or the loose file itself.
  folder        TEXT NOT NULL,
  file          TEXT NOT NULL,
  title         TEXT NOT NULL,
  sort_title    TEXT NOT NULL,
  original_title TEXT,
  year          INTEGER,
  plot          TEXT,
  genres        TEXT NOT NULL DEFAULT '[]',
  imdb_id       TEXT,
  tmdb_id       TEXT,
  runtime_minutes INTEGER,
  source        TEXT NOT NULL DEFAULT 'folder' CHECK (source IN ('folder', 'nfo')),
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  modified_at   TEXT,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (library_id, folder)
);

-- How far each person got: one row per person and episode or movie. Ids stay
-- the same across rescans, so a rescan keeps everyone's place; the daily sweep
-- drops rows whose item is gone.
CREATE TABLE IF NOT EXISTS progress (
  user_id     TEXT NOT NULL,
  item_id     TEXT NOT NULL,
  item_type   TEXT NOT NULL CHECK (item_type IN ('episode', 'movie')),
  position_s  REAL NOT NULL DEFAULT 0,
  duration_s  REAL,
  watched     INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, item_id)
);
CREATE INDEX IF NOT EXISTS progress_recent ON progress (user_id, updated_at DESC);

-- What happened, for the admin to read from home (Control panel → Apps → Events).
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  level      TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  event      TEXT NOT NULL,
  actor_id   TEXT,
  actor_name TEXT,
  library_id TEXT,
  ip         TEXT,
  request_id TEXT,
  detail     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS events_at ON events (at DESC);
CREATE INDEX IF NOT EXISTS events_event ON events (event, at DESC);
