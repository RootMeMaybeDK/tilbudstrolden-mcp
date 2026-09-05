import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataStore } from "./store.js";
import * as store from "./store.js";

function makeStore(overrides: Partial<DataStore> = {}): DataStore {
  return {
    household: {
      people: [],
      stores: [],
      defaultServings: 2,
      country: "DK",
    },
    pantry: [],
    recipes: [],
    mealHistory: [],
    spendLog: [],
    ...overrides,
  };
}

describe("datastore persistence", () => {
  let tempDirectory: string;
  let dataPath: string;
  let originalDataPath: string | undefined;

  beforeEach(async () => {
    originalDataPath = process.env.TILBUDSTROLDEN_DATA;
    tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "tilbudstrolden-store-"));
    dataPath = path.join(tempDirectory, "data.json");
    process.env.TILBUDSTROLDEN_DATA = dataPath;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalDataPath === undefined) {
      delete process.env.TILBUDSTROLDEN_DATA;
    } else {
      process.env.TILBUDSTROLDEN_DATA = originalDataPath;
    }
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  it("returns the existing first-run defaults when the file is missing", async () => {
    await expect(store.load()).resolves.toEqual(makeStore());
    await expect(fs.stat(dataPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("loads and validates an existing datastore", async () => {
    const expected = makeStore({ pantry: ["Salt"] });
    await fs.writeFile(dataPath, JSON.stringify(expected), "utf-8");

    await expect(store.load()).resolves.toEqual(expected);
  });

  it("throws for invalid JSON instead of returning an empty datastore", async () => {
    const invalid = '{"household":';
    await fs.writeFile(dataPath, invalid, "utf-8");

    await expect(store.load()).rejects.toBeInstanceOf(SyntaxError);
    await expect(fs.readFile(dataPath, "utf-8")).resolves.toBe(invalid);
  });

  it("throws for schema-invalid JSON instead of returning an empty datastore", async () => {
    const invalid = JSON.stringify({ household: { people: "not-an-array" } });
    await fs.writeFile(dataPath, invalid, "utf-8");

    await expect(store.load()).rejects.toMatchObject({ name: "ZodError" });
    await expect(fs.readFile(dataPath, "utf-8")).resolves.toBe(invalid);
  });

  it("propagates filesystem read errors other than ENOENT", async () => {
    process.env.TILBUDSTROLDEN_DATA = tempDirectory;

    const error = await store.load().then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as NodeJS.ErrnoException).code).not.toBe("ENOENT");
  });

  it("atomically saves valid JSON with private permissions and removes the temp file", async () => {
    const expected = makeStore({ pantry: ["Salt", "Sort peber"] });

    await store.save(expected);

    const saved = await fs.readFile(dataPath, "utf-8");
    expect(JSON.parse(saved)).toEqual(expected);
    await expect(store.load()).resolves.toEqual(expected);
    if (process.platform !== "win32") {
      expect((await fs.stat(dataPath)).mode & 0o777).toBe(0o600);
    }
    expect(await fs.readdir(tempDirectory)).toEqual(["data.json"]);
  });

  it("creates a missing parent directory before an atomic save", async () => {
    const nestedDirectory = path.join(tempDirectory, "nested", "store");
    dataPath = path.join(nestedDirectory, "data.json");
    process.env.TILBUDSTROLDEN_DATA = dataPath;

    await store.save(makeStore({ pantry: ["Salt"] }));

    await expect(store.load()).resolves.toMatchObject({ pantry: ["Salt"] });
  });

  it("preserves the existing target and cleans up temp data when rename fails", async () => {
    const existing = makeStore({ pantry: ["Existing"] });
    const replacement = makeStore({ pantry: ["Replacement"] });
    const originalContent = JSON.stringify(existing);
    await fs.writeFile(dataPath, originalContent, "utf-8");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("injected rename failure"));

    await expect(store.save(replacement)).rejects.toThrow("injected rename failure");

    await expect(fs.readFile(dataPath, "utf-8")).resolves.toBe(originalContent);
    expect(await fs.readdir(tempDirectory)).toEqual(["data.json"]);
  });

  it("keeps a committed save successful when the directory sync fails", async () => {
    const existing = makeStore({ pantry: ["Existing"] });
    const replacement = makeStore({ pantry: ["Replacement"] });
    await fs.writeFile(dataPath, JSON.stringify(existing), "utf-8");
    const originalOpen = fs.open.bind(fs);
    let directorySyncAttempted = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] === tempDirectory) {
        directorySyncAttempted = true;
        vi.spyOn(handle, "sync").mockRejectedValueOnce(
          new Error("injected directory sync failure"),
        );
      }
      return handle;
    });

    await expect(store.save(replacement)).resolves.toBeUndefined();

    expect(directorySyncAttempted).toBe(process.platform === "linux");
    await expect(store.load()).resolves.toEqual(replacement);
    expect(JSON.parse(await fs.readFile(dataPath, "utf-8"))).toEqual(replacement);
    expect(await fs.readdir(tempDirectory)).toEqual(["data.json"]);
  });

  it("does not seed recipes over an invalid existing datastore", async () => {
    const invalid = "not-json";
    await fs.writeFile(dataPath, invalid, "utf-8");

    await expect(store.getRecipes()).rejects.toBeInstanceOf(SyntaxError);

    await expect(fs.readFile(dataPath, "utf-8")).resolves.toBe(invalid);
    expect(await fs.readdir(tempDirectory)).toEqual(["data.json"]);
  });
});
