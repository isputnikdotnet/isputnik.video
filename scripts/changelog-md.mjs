// Renders changelog.json (the repo root; the one source of truth for what each
// release changed) as Markdown, and keeps the Unraid template's change log current.
//
//   node scripts/changelog-md.mjs                 writes CHANGELOG.md at the repo root and
//                                                 the <Date>/<Changes> of isputnik-games.xml
//   node scripts/changelog-md.mjs --version 0.25.2 prints that release's notes to stdout
//
// Same shape as isputnik.home's scripts/changelog-md.mjs, so the two repos are
// released the same way: edit changelog.json, run `npm run changelog`, commit both
// outputs with the release. Unlike home, nothing in this server reads the JSON, so
// the shape is checked here.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = "changelog.json";
const TEMPLATE = "isputnik-video.xml";
const VERSION_UPDATES = JSON.parse(fs.readFileSync(path.join(root, SOURCE), "utf8"));

checkShape(VERSION_UPDATES);

const flag = process.argv.indexOf("--version");
if (flag !== -1) {
  const wanted = (process.argv[flag + 1] ?? "").replace(/^v/, "");
  const update = VERSION_UPDATES.find((entry) => entry.version === wanted);
  if (!update) {
    console.error(`No changelog entry for version "${wanted}" in ${SOURCE}.`);
    process.exit(1);
  }
  process.stdout.write([`**${update.label}**`, "", ...update.changes.map((change) => `- ${change}`), ""].join("\n"));
} else {
  const header = [
    "# Changelog",
    "",
    `Every release, newest first. Generated from \`${SOURCE}\` by \`npm run changelog\` —`,
    "edit that file, not this one.",
    ""
  ].join("\n");
  const body = VERSION_UPDATES.map(renderRelease).join("\n");
  fs.writeFileSync(path.join(root, "CHANGELOG.md"), `${header}\n${body}`);
  console.log(`CHANGELOG.md: ${VERSION_UPDATES.length} releases.`);
  updateUnraidTemplate();
}

function renderRelease(update) {
  return [`## ${update.version} — ${update.label}`, "", ...update.changes.map((change) => `- ${change}`), ""].join("\n");
}

// Newest first, every version once, every field a non-empty string.
function checkShape(updates) {
  if (!Array.isArray(updates) || updates.length === 0) fail(`${SOURCE} must be a non-empty array.`);
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
    if (!m) fail(`"${v}" is not a version of the form X.Y.Z.`);
    return m.slice(1).map(Number);
  };
  let previous = null;
  for (const update of updates) {
    if (typeof update.version !== "string" || typeof update.label !== "string" || !update.label.trim()) {
      fail(`Entry ${JSON.stringify(update.version)} needs a version and a label.`);
    }
    if (!Array.isArray(update.changes) || update.changes.length === 0 || update.changes.some((c) => typeof c !== "string" || !c.trim())) {
      fail(`Entry ${update.version} needs at least one change, each a non-empty string.`);
    }
    const current = parse(update.version);
    if (previous) {
      const order = current.map((n, i) => Math.sign(n - previous[i])).find((s) => s !== 0) ?? 0;
      if (order >= 0) fail(`${SOURCE} must be newest first with no duplicates: ${update.version} follows ${previous.join(".")}.`);
    }
    previous = current;
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

// The Unraid Community Applications template carries the newest releases in
// <Changes> and the last release's time in <Date>; CA reads them from main to show
// the container's change log and its "last updated" date. Each release is dated by
// its v<version> tag, or today when it is not tagged yet (the release process runs
// this before tagging).
function updateUnraidTemplate() {
  const file = path.join(root, TEMPLATE);
  const SHOWN = 5;
  const original = fs.readFileSync(file, "utf8");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const today = new Date().toISOString().slice(0, 10);
  const tagDate = (version) => {
    try {
      const out = execFileSync("git", ["log", "-1", "--format=%cs", `v${version}`], {
        cwd: root,
        stdio: ["ignore", "pipe", "ignore"]
      });
      return out.toString().trim() || today;
    } catch {
      return today;
    }
  };
  const xml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const releases = VERSION_UPDATES.slice(0, SHOWN).map((update) => ({ ...update, date: tagDate(update.version) }));
  const changes = releases
    .map((update) =>
      [`### ${update.date.replace(/-/g, ".")} — ${update.version} ${update.label}`, ...update.changes.map((c) => `- ${c}`)].join(eol)
    )
    .join(eol + eol);
  const stamp = Math.floor(Date.parse(`${releases[0].date}T12:00:00Z`) / 1000);
  const block = [`  <Date>${stamp}</Date>`, `  <Changes>`, xml(changes), `  </Changes>`].join(eol);

  let next = original.replace(/[ \t]*<Date>[^<]*<\/Date>\r?\n[ \t]*<Changes>[\s\S]*?<\/Changes>/, block);
  // An element on a line of its own, so a mention of <Changes> in a comment does not count.
  if (next === original && !/^[ \t]*<Changes>/m.test(original)) {
    next = original.replace(/(<\/Overview>)/, `$1${eol}${eol}${block}`);
  }
  if (next !== original) fs.writeFileSync(file, next);
  console.log(`${TEMPLATE}: <Changes> for ${releases.map((r) => r.version).join(", ")}; <Date> ${releases[0].date}.`);
}
