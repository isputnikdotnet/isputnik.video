// A title's details as the admin edits them: over the scan's, through every
// rescan, each field able to go back to what the scan found.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { makeFixture, type Fixture } from "./helpers/fixture.js";

const SECRET = "video-secret-video-secret-0123456789";
const as = (id: string, role: "admin" | "member", libraries: string[] = []) => ({
  "x-isputnik-gateway": SECRET,
  "x-isputnik-user-id": id,
  "x-isputnik-user-role": role,
  "x-isputnik-libraries": libraries.join(","),
  "x-isputnik-client-ip": "192.168.2.10"
});
const admin = as("admin", "admin", ["lib_tv", "lib_mov"]);
const mum = as("mum", "member", ["lib_tv", "lib_mov"]);

let fixture: Fixture;
let app: FastifyInstance;

const scan = async (id: string) => {
  await app.inject({ method: "POST", url: `/video/api/admin/libraries/${id}/scan`, headers: admin });
  await app.scansSettled();
};

beforeEach(async () => {
  fixture = makeFixture();
  app = await buildApp({
    gatewaySecret: SECRET, devUser: null, dbPath: ":memory:", mediaRoot: fixture.root, version: "0.0.0-test", stage: null,
    scan: { settleMs: 60_000 },
    fastify: { logger: false }
  });
  for (const [id, body] of [["lib_tv", { name: "TV", kind: "shows", folder: "Shows" }], ["lib_mov", { name: "Movies", kind: "movies", folder: "Movies" }]] as const) {
    await app.inject({ method: "PUT", url: `/video/api/admin/libraries/${id}`, headers: admin, payload: body });
  }
  await app.scansSettled();
});

afterEach(async () => {
  await app.close();
  fixture.cleanup();
});

type Card = { id: string; title: string; year: number | null; genres: string[] };
const movies = async (query = "?sort=title") =>
  ((await app.inject({ method: "GET", url: `/video/api/movies${query}`, headers: mum })).json() as { items: Card[] }).items;
const movieId = async (title: string) => (await movies()).find((movie) => movie.title === title)!.id;
const save = (id: string, payload: unknown, headers = admin) => app.inject({ method: "PUT", url: `/video/api/admin/titles/${id}/edit`, headers, payload });
const state = async (id: string) => (await app.inject({ method: "GET", url: `/video/api/admin/titles/${id}/edit`, headers: admin })).json();

describe("editing a title", () => {
  it("puts the admin's details over the scan's, everywhere a title is read", async () => {
    const id = await movieId("Loose Film");
    const res = await save(id, { title: "A Better Name", year: 2001, plot: "Written by hand.", genres: ["Драма"] });
    expect(res.statusCode).toBe(200);
    expect(res.json().movie).toMatchObject({ title: "A Better Name", year: 2001, plot: "Written by hand.", genres: ["Драма"] });
    // Sorted and found by the new name.
    expect((await movies()).map((movie) => movie.title)).toEqual(["A Better Name", "Some Film"]);
    expect((await movies("?sort=title&q=Better")).map((movie) => movie.title)).toEqual(["A Better Name"]);
    const drama = (await app.inject({ method: "GET", url: `/video/api/titles?sort=title&genres=${encodeURIComponent("Драма")}`, headers: mum })).json() as { items: Card[] };
    expect(drama.items.map((item) => item.title)).toEqual(["A Better Name", "Радар"]);
    expect(await state(id)).toMatchObject({
      kind: "movies",
      title: { edited: "A Better Name", automatic: "Loose Film" },
      year: { edited: 2001, automatic: 1999 },
      genres: { edited: ["Драма"], automatic: [] }
    });
  });

  it("keeps the edits through a rescan, and the rescan's own changes as the automatic ones", async () => {
    const id = await movieId("Some Film");
    await save(id, { title: "Mine" });
    fixture.write("Movies/Some Film (2010)/movie.nfo", "<movie><title>Some Film Renamed</title><year>2011</year><genre>Comedy</genre></movie>");
    await scan("lib_mov");
    expect((await movies()).find((movie) => movie.id === id)).toMatchObject({ title: "Mine", year: 2011 });
    expect((await state(id)).title).toEqual({ edited: "Mine", automatic: "Some Film Renamed" });
  });

  it("hands a field back to the scan, and forgets a title with no edit left", async () => {
    const id = await movieId("Some Film");
    await save(id, { title: "Mine", year: 1950 });
    await save(id, { title: null });
    expect((await movies()).find((movie) => movie.id === id)).toMatchObject({ title: "Some Film", year: 1950 });
    await save(id, { year: null });
    expect((await movies()).find((movie) => movie.id === id)).toMatchObject({ title: "Some Film", year: 2010 });
    expect(await state(id)).toMatchObject({ title: { edited: null }, year: { edited: null, automatic: 2010 } });
    await scan("lib_mov");
    expect((await movies()).find((movie) => movie.id === id)).toMatchObject({ title: "Some Film", year: 2010 });
  });

  it("edits a show too, and sorts by a sort title of its own", async () => {
    const shows = ((await app.inject({ method: "GET", url: "/video/api/shows?sort=title", headers: mum })).json() as { items: Card[] }).items;
    const radar = shows.find((show) => show.title === "Радар")!;
    await save(radar.id, { sortTitle: "aaa" });
    const after = ((await app.inject({ method: "GET", url: "/video/api/shows?sort=title", headers: mum })).json() as { items: Card[] }).items;
    expect(after.map((show) => show.title)).toEqual(["Радар", "Counterpart"]);
  });

  it("is the admin's alone", async () => {
    const id = await movieId("Some Film");
    expect((await save(id, { title: "Nope" }, mum)).statusCode).toBe(403);
    expect((await save("nothing_here", { title: "Nope" })).statusCode).toBe(404);
  });
});
