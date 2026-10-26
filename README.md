# isputnik.video

The video engine for [isputnik.home](https://github.com/isputnikdotnet/isputnik.home):
TV shows and movies, scanned, described and (from V2) played — behind the home
server, which owns every screen and every library. This server has no pages.

How the two fit together: home's `docs/video-architecture.md` (short) and
`docs/apps-platform-plan.md` (the whole plan, phases and contract).

Status: V1 in progress (0.1.0, alpha). Catalog and library sync work; the home
side, posters, TMDB and playback come next.

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
| `GET /video/api/admin/libraries` | admin | every library with counts and scan state |
| `PUT /video/api/admin/libraries/:id` | admin | create or change a library (scans it) |
| `DELETE /video/api/admin/libraries/:id` | admin | delete it and its catalog |
| `POST /video/api/admin/libraries/sync` | admin | home's whole list: others are detached |
| `POST /video/api/admin/libraries/:id/scan` | admin | scan now |
| `GET /video/api/admin/folders?path=` | admin | folders under `MEDIA_ROOT`, for the picker |
| `GET /video/api/admin/events`, `/log` | admin | the admin's window |
| `GET /video/api/admin/backup` | admin | the whole catalog as one SQLite copy |

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
| `LOG_LEVEL` | `info` | |
| `DEV_USER` | `dev:Developer` | development without a secret: an admin who sees every library |

## Development

```
npm install
npm run dev        # :4300, the developer identity, data/ under the repo
npm test
npm run typecheck && npm run lint
```

License: AGPL-3.0-only.
