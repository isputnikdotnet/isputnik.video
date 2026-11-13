// Whether the conversion folder is a disk of its own (mounts.ts), read from
// /proc/self/mountinfo as Docker on Unraid shows it.
import { describe, expect, it } from "vitest";
import { isInside, isMappedIn, mountOf, parseMountinfo } from "../src/mounts.js";

const UNRAID = [
  "1201 1100 0:120 / / rw,relatime master:500 - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/A",
  "1202 1201 0:123 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw",
  "1210 1201 0:45 /appdata/isputnik-video /config rw,noatime - fuse.shfs shfs rw,user_id=0",
  "1211 1201 0:45 /media/video /media ro,noatime - fuse.shfs shfs rw,user_id=0",
  "1212 1201 8:17 /cache/transcode /transcode rw,noatime - btrfs /dev/sdb1 rw",
  "1213 1201 0:46 / /my\\040videos rw - xfs /dev/md1 rw"
].join("\n");

describe("the mount a folder is on", () => {
  it("reads mount points and filesystem types, undoing escapes", () => {
    const mounts = parseMountinfo(UNRAID);
    expect(mounts.map((mount) => mount.mountPoint)).toEqual(["/", "/proc", "/config", "/media", "/transcode", "/my videos"]);
    expect(mounts[4]!.fsType).toBe("btrfs");
  });

  it("is the longest mount point that holds it, never a mere name prefix", () => {
    const mounts = parseMountinfo(UNRAID);
    expect(mountOf("/transcode/copies", mounts)?.mountPoint).toBe("/transcode");
    expect(mountOf("/transcoder", mounts)?.mountPoint).toBe("/");
    expect(mountOf("/my videos/a", mounts)?.mountPoint).toBe("/my videos");
  });

  it("counts a mapped folder, and not one inside the container", () => {
    expect(isMappedIn("/transcode", UNRAID)).toBe(true);
    expect(isMappedIn("/transcode/copies", UNRAID)).toBe(true);
    const unmapped = UNRAID.split("\n").filter((line) => !line.includes(" /transcode ")).join("\n");
    expect(isMappedIn("/transcode", unmapped)).toBe(false);
    expect(isMappedIn("/tmp/isputnik-video-hls", UNRAID)).toBe(false);
    expect(isMappedIn("/transcode", "")).toBe(false);
  });

  it("tells a folder inside another", () => {
    expect(isInside("/transcode/copies", "/transcode")).toBe(true);
    expect(isInside("/transcode", "/transcode")).toBe(true);
    expect(isInside("/config/copies", "/transcode")).toBe(false);
  });
});
