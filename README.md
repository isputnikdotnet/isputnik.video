# isputnik.video

The video engine for [isputnik.home](https://github.com/isputnikdotnet/isputnik.home):
TV shows and movies, scanned, described and (from V2) played — behind the home
server, which owns every screen and every library. This server has no pages.

How the two fit together: home's `docs/video-architecture.md` (short) and
`docs/apps-platform-plan.md` (the whole plan, phases and contract).

Status: 0.11.0, alpha. Catalog, library sync and playback work, with each
person's progress (resume, next episode, Continue watching). A file a browser
plays as it is goes as it is; the rest are converted to HLS as they play — the
sound to AAC, the picture to H.264 only when a browser can't show it.
A film with several sound tracks plays the one chosen; subtitles inside it or
beside it are offered too (text as WebVTT, images burned in). Posters come
from beside the files, and from TMDB with the admin's key; films that belong
together are grouped into sets, from the .nfo files or TMDB's collections.

## The contract, from this side

- Reached only through home's gateway under `/video`. Every request carries the
  person's identity in `X-Isputnik-*` headers signed with `GATEWAY_SECRET`;
  without the secret a request is anonymous.
- `X-Isputnik-Libraries` lists the libraries the person may see. The engine keeps
  no users or permissions of its own and filters everything by that list.
- Home tells the engine about libraries (`PUT/DELETE /video/api/admin/libraries/:id`,
  `POST …/sync`); a library missing from a sync is only detached, kept 30 days.
- Home reads its events, log and a database copy for its backups; the engine
  never calls home.

| Route | Who | What |
|---|---|---|
| `GET /video/api/health` | anyone | `{ ok, version }` |
| `GET /video/api/me` | signed | who home says this is, and which libraries |
| `GET /video/api/libraries` | signed | the libraries this person may see |
| `GET /video/api/shows`, `/shows/:id` | signed | shows, then seasons and episodes |
| `GET /video/api/movies`, `/movies/:id` | signed | movies |
| `GET /video/api/play/:id?audio=` | signed | an episode or movie for the player: how it plays (`playback`: direct, remux or transcode, and its address) with the sound track asked for, its `audioTracks`, where to resume, what is next |
| `GET /video/api/stream/:id` | signed | the file, with byte ranges |
| `GET /video/api/hls/:id/t<track>/index.m3u8`, `/:n.ts` | signed | the film as HLS with that sound track, its segments cut as they are asked for |
| `DELETE /video/api/hls/:id` | signed | the player has gone: stop converting |
| `PUT /video/api/progress/:id` | signed | `{ position, duration, watched? }` — this person's place in it |
| `GET /video/api/continue` | signed | left halfway, and the next episode of a show, newest first |
| `GET /video/api/admin/libraries` | admin | every library with counts and scan state |
| `PUT /video/api/admin/libraries/:id` | admin | create or change a library (scans it) |
| `DELETE /video/api/admin/libraries/:id` | admin | delete it and its catalog |
| `POST /video/api/admin/libraries/sync` | admin | home's whole list: others are detached |
| `POST /video/api/admin/libraries/:id/scan` | admin | scan now |
| `GET /video/api/admin/folders?path=` | admin | folders under `MEDIA_ROOT`, for the picker |
| `GET /video/api/admin/events`, `/log` | admin | the admin's window |
| `GET /video/api/admin/backup` | admin | the whole catalog as one SQLite copy |
| `POST /video/api/admin/restore` | admin | puts a copy home holds back, at once, in one transaction (`application/vnd.sqlite3`, `X-Isputnik-Backup-Version`); a newer copy is refused, and so is any restore while a scan or metadata pass runs. Home's gateway refuses this path: only its Backup page calls it |
| `GET`, `POST /video/api/admin/restore/undo` | admin | describes the catalog the last restore replaced (`<db>.pre-restore`), and puts it back once |
| `GET /video/stremio/<token>/manifest.json`, `/catalog/…`, `/meta/…`, `/stream/…`, `/subtitles/…` | signed, `X-Isputnik-Site-*` and `-Base-Url` | the Stremio add-on (home's `docs/stremio-plan.md`): this install's add-on, a catalog per library, the original file and, for formats TVs refuse, a converted stream first; the token is home's to check and is masked in the log |
| `GET /video/stremio/<token>/play/:id`, `/hls/…`, `/art/…`, `/subs/…` | signed | the same bytes as the player's routes, under the add-on's address |
| `GET /video/api/admin/disks` | admin | the disks the libraries, catalog, posters and conversion folder sit on, one per mounted folder (home's Dashboard) |

## Library layout

```
Show (Year) [imdbid-tt…]/Season 01/Show (Year) S01E01 - Title.mkv   (+ .nfo, tvshow.nfo)
Movie (Year) [tmdbid-…]/Movie (Year).mkv                            (+ movie.nfo)
```

The layout Jellyfin and Kodi read. `.nfo` files come first; names fill in the
rest, including release names as they are downloaded. A file written in the last
two minutes is left for the next scan, so a copy in progress is never catalogued.

## Configuration

| Variable | Default | |
|---|---|---|
| `GATEWAY_SECRET` | unset | from home's Control panel → Apps → Setup; required in production |
| `MEDIA_ROOT` | `data/media` | the video folders, mounted read-only (image: `/media`) |
| `DB_PATH` | `data/video.sqlite` | the catalog (image: `/config/video.sqlite`) |
| `PORT` / `HOST` | `4300` / `127.0.0.1` | |
| `TRANSCODE_PATH` | temp folder | where ffmpeg writes segments while someone watches (image: `/transcode`); finished ones move into memory up to the share set on home's Apps → Installed, the rest stay here; emptied on start |
| `ART_PATH` | `art` beside `DB_PATH` | posters, backdrops and stills fetched from TMDB (image: `/config/art`); not in backups — fetched again |
| `FFMPEG_PATH` / `FFPROBE_PATH` | on `PATH` | the image installs both; a checkout uses the ffmpeg-static dev dependencies |
| `LOG_LEVEL` | `info` | |
| `DEV_USER` | `dev:Developer` | development without a secret: an admin who sees every library |

## Running it

The image is `ghcr.io/isputnikdotnet/isputnik.video` (tags `latest`, `0.4`,
`0.4.0`); on Unraid, install it from `isputnik-video.xml`. It publishes no port:
put it on the same user-defined Docker network as the isputnik container
(`docker network create isputnik`), mount `/config` (the catalog) and `/media`
(the video share, read-only) — and, if you like, `/transcode` on RAM or a fast
disk — then:

1. In home, Control panel → Apps → Setup → Video: save the address
   `http://isputnik-video:4300`.
2. On the same page, **Generate secret**; paste it here as `GATEWAY_SECRET`. The
   container won't start without it.
3. Add a library: Control panel → Library → Libraries → Add library → Video.

Home's guide `docs/users/apps.md` has the whole walk-through.

## Development

```
npm install
npm run dev        # :4300, the developer identity, data/ under the repo
npm test
npm run typecheck && npm run lint
```

License: AGPL-3.0-only.
