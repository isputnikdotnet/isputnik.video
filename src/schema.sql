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
  nfo_people    TEXT NOT NULL DEFAULT '[]',   -- the .nfo's <actor>/<director>/<credits> (credits.ts)
  imdb_id       TEXT,
  tmdb_id       TEXT,
  -- 'nfo' when tvshow.nfo described it, 'folder' when only its name did.
  source        TEXT NOT NULL DEFAULT 'folder' CHECK (source IN ('folder', 'nfo')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- When the scan first found it: what "Recently added" sorts by, shows and films alike.
  added_at      TEXT,
  -- When the scan last found an episode the show didn't have (a number new to it,
  -- not a file renamed): a new season makes the show recently added again.
  new_episode_at TEXT,
  UNIQUE (library_id, folder)
);
CREATE INDEX IF NOT EXISTS shows_added ON shows (added_at DESC);

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
  -- Relative to the library folder: the movie's folder, or the file itself when
  -- the film has no folder to itself (a loose file, a film of a folder of films).
  -- `file` is then the same path; otherwise it is relative to `folder`.
  folder        TEXT NOT NULL,
  file          TEXT NOT NULL,
  title         TEXT NOT NULL,
  sort_title    TEXT NOT NULL,
  original_title TEXT,
  year          INTEGER,
  plot          TEXT,
  genres        TEXT NOT NULL DEFAULT '[]',
  nfo_people    TEXT NOT NULL DEFAULT '[]',
  imdb_id       TEXT,
  tmdb_id       TEXT,
  runtime_minutes INTEGER,
  -- The set the .nfo puts it in (<set>), else the folder of films it sits in;
  -- sets.ts groups by it.
  set_name      TEXT,
  set_overview  TEXT,
  set_tmdb_id   TEXT,
  -- Where its file's name puts it in the set ("… part-3"), if it says.
  set_order     INTEGER,
  source        TEXT NOT NULL DEFAULT 'folder' CHECK (source IN ('folder', 'nfo')),
  -- Of all its parts, when the film is in several files.
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  modified_at   TEXT,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- When the scan first found it (see shows.added_at).
  added_at      TEXT,
  UNIQUE (library_id, folder)
);
CREATE INDEX IF NOT EXISTS movies_added ON movies (added_at DESC);

-- The second part of a film in several files, and those after it. movies.file
-- and movies.id are the first part. A part plays and keeps its place like any
-- film, by its own id.
CREATE TABLE IF NOT EXISTS movie_parts (
  id          TEXT PRIMARY KEY,
  movie_id    TEXT NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  part        INTEGER NOT NULL,
  -- From the same place as movies.file.
  file        TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  modified_at TEXT,
  UNIQUE (movie_id, file)
);
CREATE INDEX IF NOT EXISTS movie_parts_order ON movie_parts (movie_id, part);

-- How far each person got: one row per person and episode or movie. Ids stay
-- the same across rescans, so a rescan keeps everyone's place; the daily sweep
-- drops rows whose item is gone. user_id is whose history it is (Identity.historyId):
-- a person's id, or "profile:<id>" for one of home's household viewing profiles.
CREATE TABLE IF NOT EXISTS progress (
  user_id     TEXT NOT NULL,
  item_id     TEXT NOT NULL,
  item_type   TEXT NOT NULL CHECK (item_type IN ('episode', 'movie')),
  position_s  REAL NOT NULL DEFAULT 0,
  duration_s  REAL,
  watched     INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Taken off Continue watching by hand; playing or marking it again brings it back.
  dismissed   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, item_id)
);
CREATE INDEX IF NOT EXISTS progress_recent ON progress (user_id, updated_at DESC);

-- What is inside each file, from ffprobe: its streams for choosing how it
-- plays, and where its keyframes are for cutting it (a whole-file read, so it
-- is kept). Stale once the file's size or date changes; the sweep drops rows
-- whose item is gone.
CREATE TABLE IF NOT EXISTS media_probe (
  item_id      TEXT PRIMARY KEY,
  size         INTEGER NOT NULL,
  modified_ms  INTEGER NOT NULL,
  info         TEXT NOT NULL,
  keyframes    TEXT,
  probed_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Where an intro and the credits are, marked by an admin in home's player
-- (markers.ts), in seconds on the title's own clock. One row per item and kind:
-- an episode's or film's own mark (season -1: a NULL in a key would let
-- duplicates in), or a season's, kept on the show. The episode's own wins.
-- The .edl and chapters are read when asked and never stored here.
CREATE TABLE IF NOT EXISTS markers (
  item_id     TEXT NOT NULL,
  season      INTEGER NOT NULL DEFAULT -1,
  -- A recap is only ever an episode's own (season -1). db.ts widens a table from
  -- before recaps (0.17.0).
  kind        TEXT NOT NULL CHECK (kind IN ('intro', 'credits', 'recap')),
  start_s     REAL NOT NULL,
  -- NULL for the credits: they run to the end.
  end_s       REAL,
  source      TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'detected')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (item_id, season, kind)
);

-- What the engine found by itself (detect.ts): an episode's intro by the sound its
-- season shares, the credits by the black they sit on. One row per episode or film
-- file, for that file as it was (size and date); NULLs where nothing was found.
-- Apart from markers: an admin's mark, an .edl and chapters all win over these.
CREATE TABLE IF NOT EXISTS detected_markers (
  item_id       TEXT PRIMARY KEY,
  size          INTEGER NOT NULL,
  modified_ms   INTEGER NOT NULL,
  intro_start   REAL,
  intro_end     REAL,
  -- 1 once its season was compared with it in it; a film's is always 1.
  intro_checked INTEGER NOT NULL DEFAULT 0,
  credits_start REAL,
  -- "Previously on", by picture (0.17.0): 1 once looked for; a film's is always 1.
  recap_start   REAL,
  recap_end     REAL,
  recap_checked INTEGER NOT NULL DEFAULT 0,
  detected_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Each episode's picture, for finding recaps (detect.ts): 4 frames a second, each
-- a 64-bit hash (8 bytes, low word first) of the frame at 9×8 grey; 0 for a frame
-- with no contrast. ~100 KB an episode. Stale once the file's size or date changes.
CREATE TABLE IF NOT EXISTS picture_prints (
  item_id     TEXT PRIMARY KEY,
  size        INTEGER NOT NULL,
  modified_ms INTEGER NOT NULL,
  prints      BLOB NOT NULL,
  made_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The admin's choices (settings.ts): one row per setting, its value JSON.
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

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

-- Posters, backdrops, stills and TMDB's words for each show, movie and episode
-- (metadata.ts). Apart from what the scan writes, so a rescan never undoes it and
-- a match fixed by hand (`locked`) stays. Picture columns say where the file is:
-- 'local:<path under MEDIA_ROOT>' beside the video, 'cache:<file>' in the art
-- folder; the *_path columns are TMDB's own image paths, to tell when one changed.
CREATE TABLE IF NOT EXISTS metadata (
  item_id        TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('show', 'movie', 'episode')),
  tmdb_id        TEXT,
  locked         INTEGER NOT NULL DEFAULT 0,
  tmdb_state     TEXT NOT NULL DEFAULT 'none' CHECK (tmdb_state IN ('none', 'matched', 'unmatched', 'error')),
  title          TEXT,
  original_title TEXT,
  plot           TEXT,
  year           INTEGER,
  aired          TEXT,
  genres         TEXT NOT NULL DEFAULT '[]',
  rating         REAL,
  status         TEXT,
  poster         TEXT,
  backdrop       TEXT,
  still          TEXT,
  poster_path    TEXT,
  backdrop_path  TEXT,
  still_path     TEXT,
  checked_at     TEXT,
  error          TEXT,
  -- A film's TMDB collection (belongs_to_collection); set_checked is 0 until
  -- TMDB has been asked since sets came in, so older matches are asked again.
  set_tmdb_id    TEXT,
  set_name       TEXT,
  set_checked    INTEGER NOT NULL DEFAULT 0,
  -- A TMDB backdrop the admin chose (Fix match); backdrop_path follows it. And
  -- 1 once the backdrop was picked from TMDB's textless ones by votes (0.18.0).
  backdrop_choice TEXT,
  backdrop_picked INTEGER NOT NULL DEFAULT 0,
  -- A TMDB poster the admin chose (poster_path follows it), and a poster the admin
  -- uploaded (a cache: name in the art folder), which wins over every other.
  poster_choice  TEXT,
  poster_upload  TEXT,
  -- Where on TMDB the match was found: a film TMDB files as a TV show (a Soviet
  -- miniseries) is matched there and read from /tv. Null before 0.21.0: the
  -- title's own kind.
  tmdb_kind      TEXT CHECK (tmdb_kind IN ('movie', 'tv')),
  -- TMDB's cast and crew of a show or film (credits.ts), and 1 once asked for
  -- them (0.26.0), so titles matched before are asked once more.
  people         TEXT NOT NULL DEFAULT '[]',
  people_checked INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Films that belong together (sets.ts): a TMDB collection, or a name the
-- .nfo files share. Rebuilt from movies + metadata after every scan and
-- metadata pass, so it never drifts from them; ids stay while the set has films.
CREATE TABLE IF NOT EXISTS sets (
  id             TEXT PRIMARY KEY,
  tmdb_id        TEXT UNIQUE,
  name_key       TEXT UNIQUE,
  name           TEXT NOT NULL,
  sort_name      TEXT NOT NULL,
  overview       TEXT,
  -- TMDB's words and art for the collection, and its parts' release dates.
  tmdb_name      TEXT,
  tmdb_overview  TEXT,
  parts          TEXT NOT NULL DEFAULT '[]',
  poster         TEXT,
  backdrop       TEXT,
  poster_path    TEXT,
  backdrop_path  TEXT,
  checked_at     TEXT,
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Which set each film is in: one at most. 'released' orders the set.
CREATE TABLE IF NOT EXISTS set_members (
  movie_id   TEXT PRIMARY KEY,
  set_id     TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
  source     TEXT NOT NULL CHECK (source IN ('nfo', 'tmdb')),
  released   TEXT
);
CREATE INDEX IF NOT EXISTS set_members_set ON set_members (set_id);

-- The admin's own genres (genres.ts): a title's raw genres — the .nfo's, else
-- TMDB's — are mapped onto them. A raw word that is a keyword becomes its
-- genre(s); a hidden one becomes nothing; any other shows as it came. Keys are
-- genreKey(): case, spacing and ё don't count.
CREATE TABLE IF NOT EXISTS genres (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  name_key    TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A word that leads to a genre; one word may lead to several ("Sci-Fi & Fantasy").
CREATE TABLE IF NOT EXISTS genre_keywords (
  keyword_key TEXT NOT NULL,
  keyword     TEXT NOT NULL,
  genre_id    TEXT NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
  PRIMARY KEY (keyword_key, genre_id)
);
CREATE INDEX IF NOT EXISTS genre_keywords_genre ON genre_keywords (genre_id);

-- Words no card shows ("TV Movie").
CREATE TABLE IF NOT EXISTS genre_hidden (
  keyword_key TEXT PRIMARY KEY,
  keyword     TEXT NOT NULL
);

-- A film's or show's details as the admin edited them (edits.ts): null is
-- automatic. auto_* keep what the scan last found, so a field can go back to it;
-- the shows/movies row itself holds edit ?? automatic.
CREATE TABLE IF NOT EXISTS title_edits (
  item_id             TEXT PRIMARY KEY,
  kind                TEXT NOT NULL CHECK (kind IN ('shows', 'movies')),
  title               TEXT,
  original_title      TEXT,
  sort_title          TEXT,
  year                INTEGER,
  plot                TEXT,
  genres              TEXT,
  auto_title          TEXT NOT NULL,
  auto_original_title TEXT,
  auto_year           INTEGER,
  auto_plot           TEXT,
  auto_genres         TEXT NOT NULL DEFAULT '[]',
  -- A film's set by hand: a name (joins TMDB's of that name) and its place in it,
  -- or no_set = 1 for none at all, which TMDB's collection doesn't override.
  set_name            TEXT,
  set_order           INTEGER,
  no_set              INTEGER NOT NULL DEFAULT 0,
  auto_set_name       TEXT,
  auto_set_tmdb_id    TEXT,
  auto_set_order      INTEGER,
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- People in films and shows (credits.ts): one row per person, worked out again
-- from the titles' .nfo files and TMDB's credits after every scan and metadata
-- pass. The id is TMDB's ("t123") where it is known, else made from the name
-- ("n…"), so a person's address stays while they are in the library.
CREATE TABLE IF NOT EXISTS people (
  id            TEXT PRIMARY KEY,
  tmdb_id       TEXT UNIQUE,
  name          TEXT NOT NULL,
  name_key      TEXT NOT NULL,
  -- TMDB's picture of them, and where it is kept once fetched ("cache:<file>").
  profile_path  TEXT,
  photo         TEXT
);
CREATE INDEX IF NOT EXISTS people_name ON people (name_key);

-- Who is in a title: the cast in billing order (role: the character), and the
-- crew (role: director, writer, composer or creator).
CREATE TABLE IF NOT EXISTS credits (
  item_id    TEXT NOT NULL,
  person_id  TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('cast', 'crew')),
  role       TEXT NOT NULL DEFAULT '',
  position   INTEGER NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('nfo', 'tmdb')),
  PRIMARY KEY (item_id, person_id, kind, role)
);
CREATE INDEX IF NOT EXISTS credits_person ON credits (person_id);

-- Copies made for download (copies.ts): a film or episode as a smaller MP4, kept
-- for whoever asks next. One per title, quality and sound track; the file is in
-- the copies folder under the same name. Only finished ones outlive a restart.
CREATE TABLE IF NOT EXISTS copies (
  item_id          TEXT NOT NULL,
  rung             INTEGER NOT NULL,
  audio            INTEGER NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('queued', 'running', 'ready', 'failed')),
  title            TEXT NOT NULL DEFAULT '',
  size_bytes       INTEGER NOT NULL DEFAULT 0,
  -- The file it was made from: a different size or date is a different film.
  source_size      INTEGER NOT NULL,
  source_modified  TEXT NOT NULL,
  error            TEXT,
  requested_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ready_at         TEXT,
  used_at          TEXT,
  PRIMARY KEY (item_id, rung, audio)
);

-- Keep ready (keep-ready.ts, home's docs/video-cache-plan.md C3): titles an admin
-- wants converted ahead of time at the qualities named, and kept. A film, a whole
-- show, or one season of it; `items` is the episodes there were when it was set,
-- for a show or season whose new episodes are not to follow (NULL: they follow).
CREATE TABLE IF NOT EXISTS keep_ready (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('movie', 'show', 'season')),
  target_id    TEXT NOT NULL,
  season       INTEGER,
  rungs        TEXT NOT NULL,
  items        TEXT,
  title        TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The hardware test (hardware-test.ts): each run whole, as JSON, the last 20 kept.
CREATE TABLE IF NOT EXISTS hardware_tests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  phase        TEXT NOT NULL,
  result       TEXT NOT NULL
);

-- What the GPU check found changing between starts: a GPU, its driver, ffmpeg
-- (hardware-test.ts, noteHardware). The last 50 kept.
CREATE TABLE IF NOT EXISTS hardware_changes (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL,
  before   TEXT NOT NULL,
  after    TEXT NOT NULL,
  summary  TEXT NOT NULL
);

-- The disk check (disk-check.ts): each run whole, as JSON, the last 20 kept.
CREATE TABLE IF NOT EXISTS disk_checks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  phase        TEXT NOT NULL,
  result       TEXT NOT NULL
);
