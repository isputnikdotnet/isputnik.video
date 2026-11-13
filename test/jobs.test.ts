// When the queue works (copies.ts gate) and how fast copies go away from home
// (throttle.ts): the pieces on their own.
import { describe, expect, it } from "vitest";
import { inWindow } from "../src/copies.js";
import { Bucket } from "../src/throttle.js";

const at = (hours: number, minutes = 0) => new Date(2026, 10, 12, hours, minutes);

describe("the night window", () => {
  it("holds within the same day and across midnight", () => {
    expect(inWindow(at(2), "01:00", "07:00")).toBe(true);
    expect(inWindow(at(7), "01:00", "07:00")).toBe(false);
    expect(inWindow(at(12), "01:00", "07:00")).toBe(false);
    expect(inWindow(at(23, 30), "22:00", "06:00")).toBe(true);
    expect(inWindow(at(5, 59), "22:00", "06:00")).toBe(true);
    expect(inWindow(at(6), "22:00", "06:00")).toBe(false);
  });
});

describe("the bucket for downloads away from home", () => {
  it("lets bytes through no faster than its rate, and everything through at 0", async () => {
    let rate = 100_000;
    const bucket = new Bucket(() => rate);
    const started = Date.now();
    for (let sent = 0; sent < 250_000; sent += 50_000) await bucket.take(50_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
    rate = 0;
    const again = Date.now();
    await bucket.take(10_000_000);
    expect(Date.now() - again).toBeLessThan(50);
  });
});
