// A media folder shaped like a family's: a tidy show with .nfo files, a show as
// it was downloaded, a movie with an .nfo, a loose film file, and one file still
// being copied. Every file is dated an hour ago except the one still arriving.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Fixture {
  root: string;
  write(relative: string, content?: string, options?: { fresh?: boolean }): string;
  remove(relative: string): void;
  cleanup(): void;
}

const HOUR_AGO = () => new Date(Date.now() - 60 * 60 * 1000);

export function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-video-media-"));
  const write = (relative: string, content = "video", options: { fresh?: boolean } = {}) => {
    const file = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    if (!options.fresh) fs.utimesSync(file, HOUR_AGO(), HOUR_AGO());
    return file;
  };

  const radar = "Shows/Radar (2026) [imdbid-tt33022834]";
  write(`${radar}/tvshow.nfo`, `<?xml version="1.0" encoding="utf-8"?>
<tvshow><title>Радар</title><year>2026</year><plot>1988 год.</plot><genre>Драма</genre><genre>Фантастика</genre>
<uniqueid type="imdb" default="true">tt33022834</uniqueid></tvshow>`);
  for (let n = 1; n <= 3; n++) {
    write(`${radar}/Season 01/Radar (2026) S01E0${n} - Серия ${n}.mkv`, "x".repeat(100 * n));
    write(`${radar}/Season 01/Radar (2026) S01E0${n} - Серия ${n}.nfo`,
      `<episodedetails><title>Серия ${n}</title><season>1</season><episode>${n}</episode><aired>2026-04-2${n}</aired></episodedetails>`);
  }

  const counterpart = "Shows/Counterpart.S02.1080p.Wanterlude";
  write(`${counterpart}/Counterpart.S02E01.Inside.Out.1080p.Wanterlude.mkv`);
  write(`${counterpart}/Counterpart.S02E02.Outside.In.1080p.Wanterlude.mkv`);
  write(`${counterpart}/Sample/sample.txt`, "not a video");
  // Still being copied: left for the next scan.
  write(`${counterpart}/Counterpart.S02E03.Something.Borrowed.1080p.Wanterlude.mkv`, "partial", { fresh: true });
  // No number in the name, no .nfo: noted, not guessed.
  write(`${counterpart}/Counterpart.Behind.The.Scenes.mkv`);

  write("Movies/Some Film (2010)/Some Film (2010).mkv", "x".repeat(5000));
  write("Movies/Some Film (2010)/trailer.mkv", "x".repeat(50));
  write("Movies/Some Film (2010)/movie.nfo", "<movie><title>Some Film</title><year>2010</year><runtime>112</runtime><genre>Comedy</genre></movie>");
  write("Movies/Loose Film (1999).mp4", "x".repeat(3000));
  // Not a library: something the picker shows next to them.
  fs.mkdirSync(path.join(root, "Kids"), { recursive: true });

  return {
    root,
    write,
    remove: (relative) => fs.rmSync(path.join(root, ...relative.split("/")), { recursive: true, force: true }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}
