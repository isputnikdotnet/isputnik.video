# Contributing to isputnik.video

Thanks for helping. Bug reports from real libraries and real hardware are what
this engine needs most; pull requests are welcome too, especially for issues you
reported yourself.

## Before you start

- **Open an issue first** for anything bigger than a small fix, so we can agree
  on the approach before you spend time on it. A pull request should name the
  issue it closes.
- The engine has **no pages of its own**. Everything a person sees lives in
  [isputnik.home](https://github.com/isputnikdotnet/isputnik.home). A change that
  needs a new screen or setting also needs a change in home; say so in the issue.
- Please don't bump the version or edit `changelog.json` / `CHANGELOG.md`; that
  happens at release time.

## Running it

```
npm install
npm run dev        # :4300, the developer identity, data/ under the repo
npm test
npm run typecheck && npm run lint
```

CI runs typecheck, lint and every test on each pull request, with Debian's
`ffmpeg` (as the image ships). On Linux, prefer the system `ffmpeg` over the
`ffmpeg-static` dev dependency: its static build crashes on MPEG-TS → MP4 remux.
Point `FFMPEG_PATH` / `FFPROBE_PATH` at it.

To measure how long a scan holds the server up against a real folder (a NAS
share, say), from a checkout rather than the image:

```
npm run bench:scan -- <folder holding Movies/ and Shows/>
npm run bench:scan -- /mnt/user/Media --shows Series --movies Films
```

`--movies` and `--shows` name the libraries' folders when they are not `Movies`
and `Shows` (exact names: `Series` is not `series`). Run it with no folder to use
a generated fake library.

## The engine's ground rules

These come from real bugs; a change that breaks one will be asked to change.

- **Never block the event loop.** No `readFileSync`, `statSync`, `readdirSync`
  and friends on a request path, in a scan, or in anything a request waits on.
  Use `fs.promises`. A library on a sleeping NAS disk turns one sync call into a
  frozen server (issues #1, #5, #6).
- **Keep database transactions short.** `better-sqlite3` is synchronous: gather
  everything first, then write in one transaction with no disk I/O, network or
  ffmpeg inside it.
- **Schema changes:** `src/schema.sql` is idempotent and runs on every start; a
  new table goes there. A new column on an existing table goes in
  `ADDED_COLUMNS` in `src/db.ts` as well, so existing catalogs get it.
- **Identity comes from home.** The engine keeps no users or permissions; it
  filters by the `X-Isputnik-Libraries` header, trusted only when signed with
  `GATEWAY_SECRET`. Never widen what a request may see.
- **No new container settings** for things an admin would choose. Settings live
  in the app (and home's control panel); environment variables are for wiring
  the container (paths, the secret, ports).
- **Tests come with the change.** A bug fix gets a test that fails without it;
  tests live in `test/`.

Code written with an AI assistant is fine. You are still the author: read it,
run it, and be able to explain it in review.

## Sign your commits (DCO)

Every commit must carry a `Signed-off-by` line, which certifies the
[Developer Certificate of Origin](https://developercertificate.org/) (below):
that you wrote the change, or otherwise have the right to submit it under this
project's license. Git adds the line for you:

```
git commit -s -m "fix: scan reads .nfo files asynchronously"
```

which ends the message with

```
Signed-off-by: Your Name <you@example.com>
```

using your `user.name` and `user.email`. Use your real name, or the name you are
known by on GitHub. Forgot? `git commit --amend -s` fixes the last commit, and
`git rebase --signoff main` fixes all of a branch's commits.

Contributions are accepted under the project's license, **AGPL-3.0-only**
(see `LICENSE`).

### Developer Certificate of Origin 1.1

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```
