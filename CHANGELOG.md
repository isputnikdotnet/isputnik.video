# Changelog

Every release, newest first. Generated from `changelog.json` by `npm run changelog` —
edit that file, not this one.

## 0.36.0 — Big films start sooner

- **The first play of a big MKV no longer waits for the whole file to be read.** A film whose picture is sent as it is can only be cut where its keyframes are, and the engine used to find them by reading every byte of the file. On a 30 GB Blu-ray rip on an array disk that took several minutes (longer than the player waited), so the film sat on "Getting it ready…" or failed to start the first time. The keyframes now come from the file's own index, checking each one the way ffmpeg does, since MakeMKV and mkvmerge mark more frames than ffmpeg can cut on: seconds instead of minutes. A file whose index won't do is read as before.
- **Keyframes are read ahead.** After each scan and when the engine starts, it reads the keyframes of the titles that will need them, one file at a time and never starting a new one while someone is watching, so even a file that has to be read whole is ready before anyone presses Play.

## 0.35.0 — Memory first, one cache, kept ready

- **Converted video stays out of the container.** The engine now checks whether `/transcode` is a disk mapped into the container. If it isn't (the Unraid template's Transcode path left empty), video is converted in memory only and no copies for download are prepared there, so nothing fills `docker.img`. With a disk, the admin picks memory only, memory then the disk (the default), or the disk only, and one memory limit is shared by everyone watching (a tenth of the server's memory, at most 1 GB, to start with). isputnik.home 4.88 shows the disk and its free space on Settings › Video › Converting video. Older homes keep working with their memory-per-viewer setting.
- **One conversion per version, shared.** Two people watching the same film at the same quality and sound track now share one conversion instead of making it twice, and joining a film someone is already watching takes no place from the household's limit.
- **Films kept once converted all the way through.** With a disk, a film whose picture had to be re-encoded is kept once someone has watched it to the end, so it plays next time with nothing converted, also after a restart. A film left at 70% or more is finished off in the background so it is kept too. Kept films and copies for download share one limit (Room for kept video, 50 GB to start with); the ones used longest ago go first.
- **Copies for download are made through the same cache.** A copy whose picture is re-encoded is made as the version a viewer would get, a stretch at a time and resumable, then put together into the MP4 in seconds. Copies asked for are carried on after a restart.
- **Keep ready.** An admin can keep a film, a show or one season ready at 1080p, 720p or 480p (`/admin/keep-ready`): converted ahead of time in the background and never removed to make room. A show's new episodes follow unless asked not to.
- **When downloads are prepared.** The queue runs right away, only when the server is idle, or only between two times at night, with a number of jobs at once and a limit on how many downloads one member may have waiting (`/admin/jobs`). Copies going to someone away from home can be held to a download speed so streaming keeps its share of the upload link.

## 0.34.0 — Off the row, and new again

- **Take something off Continue watching.** `DELETE /video/api/continue/:id` takes a show (asked by any of its episodes) or a film (every part of it) off the row for the person asking, so isputnik.home 4.86 can offer **Remove from Continue watching** on each card. Nothing is forgotten: the place in it stays, and playing it again, or marking it watched or unwatched, brings it back. Before, a film abandoned halfway or a show nobody meant to go on with stayed on the row for good.
- **Every film and show card says when it came** (`addedAt`), so home can keep **Recently added** to the last weeks instead of calling a years-old title new just because nothing came after it.
- **A new season makes a show new again.** A show is now dated by the later of when it was first found and when the scan last found an episode it didn't have, so it moves back to the top of Recently added. A file renamed or moved to another folder, with the same season and episode number, doesn't count. Episodes found before this version don't count either: only those the scan finds from now on.

## 0.33.0 — Copies prepared for download

- **A download optimized for a phone or tablet is now prepared here, on a queue.** isputnik.home 4.82 asks for a smaller copy of a film or episode (480p, 720p or 1080p); the engine makes it as one MP4 and the device fetches the finished file at full speed. Before, the film was converted while the phone waited on the connection, which was slow and loaded the server for as long as the download took.
- **Kind to the server.** One copy is made at a time, on the GPU where there is one; without one, at low priority and with half the CPU's cores. A copy being made stands still while anyone is watching converted video, and carries on after.
- **Kept for the next person.** A copy made once serves everyone who may see that title. Together they stay under a size set in home's Settings → Video → **Copies for download** (20 GB to start with); past it, the ones used longest ago go. A copy of a file that has changed since is made again.
- **Where they are kept:** in a `copies` folder inside `/transcode` when that is mapped, otherwise beside the catalog. Map `/transcode` to a disk with room for them. The conversion folder is still emptied on start, but no longer the copies in it.
- A 1080p copy is held to about 2.5 GB for a two-hour film, lower than a 1080p stream; 720p is about 1.4 GB and 480p about 0.7 GB.

## 0.32.0 — What you have watched

- **Every card says where you are in it.** The lists isputnik.home draws its posters from now carry, for the person asking, a film's place (a film in several files counting as one) and a show's count of episodes seen, so home 4.81 can draw a bar on a film left part-way, a check on a finished one and "8 unwatched" on a show, without a request per poster.
- **A list narrows by it.** `/titles?watch=` takes unwatched, progress and watched, any of them: home's new Watched filter. A show counts as watched only once every episode is, so a new episode brings it back.
- **A whole show, a season or a film is marked in one call.** `PUT /video/api/watched/:kind/:id` marks every episode of a show, or of one season, or every part of a film, watched or never seen, for the person asking. Marked watched, what follows them is next: seasons 1 to 3 make season 4's first episode next up. Marked unwatched, their history goes and nothing is left to resume. Before, only one episode or film could be marked at a time.
- Each person's marks, and each viewing profile's, stay their own, as progress always was.

## 0.31.1 — On Docker Hub, and ready for Unraid Community Applications

- **The image is on Docker Hub too, as isputnikdotnet/isputnik.video.** Every release tag publishes the same image to ghcr.io and to Docker Hub, as isputnik.home's does, and the Docker Hub page shows this README under a description that says what the container is: an add-on for isputnik.home. Every public description now says so: the GitHub repository, the image, the Unraid template and its profile.
- **Ready for Unraid Community Applications as isputnik-video.** The template now publishes port 4300 on the ordinary bridge network, so isputnik.home reaches the engine at the server's own address with nothing to create first; a shared Docker network or br0 with a fixed IP work as before. It sends the administrator to isputnik.home's Control panel → Settings → Apps for the pairing, where the secret is generated first and pasted into Gateway Secret, and it carries this change log, regenerated by `npm run changelog` on every release.

## 0.31.0 — Quality for viewers away from home

- **Quality rungs.** The player's Quality menu in isputnik.home 4.78 asks this engine for Original, 1080p, 720p or 480p, made while the film plays; a film already smaller than the rung is sent as it is. Someone watching from outside the home network is held under the cap set in Settings → Video (up to 720p to start with), read from the gateway's network header, because a Blu-ray rip sent as it is needs more upload than a home link has.

## 0.30.0 — Profiles keep their own history

- **Viewing profiles keep their own history.** Continue watching, watched marks and My list belong to the profile isputnik.home 4.76 forwards, the same on every TV and browser, so the cartoons stay out of the grown-ups' Continue watching.

## 0.29.0 — Without Stremio

- **The Stremio add-on's routes are gone**, with the add-on itself in isputnik.home 4.74. An older home keeps working; the engine only stops answering on addresses nothing asks for any more.

## 0.28.1 — Pictures for a film's parts

- **A film in several parts shows pictures for each part**: a part matched to an episode of a TV show on TMDB gets that episode's picture, name and description.
