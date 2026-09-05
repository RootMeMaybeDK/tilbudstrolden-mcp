import { type ChildProcess, fork } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DataStore, Recipe } from "./store.js";
import * as store from "./store.js";

type ChildMessage = {
  type: "starting" | "inside" | "initial-read" | "done" | "error";
  name?: string;
  code?: string;
  message?: string;
  recipeNames?: string[];
  callbackRan?: boolean;
};

type ChildCommand =
  | {
      type: "modify";
      pantryItem?: string;
      country?: string;
      recipe?: Recipe;
      hold?: boolean;
    }
  | { type: "add-recipe"; recipe: Recipe }
  | { type: "get-recipes"; pauseAfterInitialRead?: boolean };

const workerPath = fileURLToPath(new URL("../test/fixtures/store-writer.ts", import.meta.url));

interface FixtureExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  messages: unknown[];
  stderr: string;
}

async function runFixtureUntilExit(env: NodeJS.ProcessEnv): Promise<FixtureExit> {
  const fixture = fork(workerPath, [], {
    execArgv: ["--import", "tsx"],
    env,
    serialization: "advanced",
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages: unknown[] = [];
  let stderr = "";
  fixture.on("message", (message) => messages.push(message));
  fixture.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<FixtureExit>((resolve, reject) => {
        fixture.once("error", reject);
        fixture.once("close", (code, signal) => resolve({ code, signal, messages, stderr }));
      }),
      new Promise<FixtureExit>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Fixture did not reject unsafe configuration")),
          2000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (fixture.exitCode === null && fixture.signalCode === null) fixture.kill("SIGKILL");
  }
}

function makeStore(): DataStore {
  return {
    household: { people: [], stores: [], defaultServings: 2, country: "DK" },
    pantry: [],
    recipes: [],
    mealHistory: [],
    spendLog: [],
  };
}

function makeRecipe(name: string): Recipe {
  return {
    name,
    ingredients: [],
    servings: 2,
    complexity: "quick",
    cuisineType: "danish",
    proteinType: "vegetarian",
  };
}

class ChildController {
  readonly child: ChildProcess;
  private readonly queued: ChildMessage[] = [];
  private readonly waiters: Array<{
    type: ChildMessage["type"];
    resolve: (message: ChildMessage) => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(dataPath: string) {
    this.child = fork(workerPath, [], {
      execArgv: ["--import", "tsx"],
      env: { ...process.env, TILBUDSTROLDEN_DATA: dataPath },
      serialization: "advanced",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.child.on("message", (message: ChildMessage) => this.dispatch(message));
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.rejectAll(new Error(`Child stderr: ${chunk.toString()}`));
    });
    this.child.on("exit", (code, signal) => {
      if (this.waiters.length > 0) {
        this.rejectAll(new Error(`Child exited before expected IPC message (${code ?? signal})`));
      }
    });
  }

  send(command: ChildCommand | { type: "continue" }): void {
    this.child.send(command);
  }

  waitFor(type: ChildMessage["type"]): Promise<ChildMessage> {
    const index = this.queued.findIndex((message) => message.type === type);
    if (index >= 0) return Promise.resolve(this.queued.splice(index, 1)[0]);
    return new Promise((resolve, reject) => this.waiters.push({ type, resolve, reject }));
  }

  async expectNoMessage(type: ChildMessage["type"], milliseconds = 150): Promise<void> {
    await expect(
      Promise.race([
        this.waitFor(type).then(() => "received"),
        new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), milliseconds)),
      ]),
    ).resolves.toBe("timeout");
    const waiterIndex = this.waiters.findIndex((waiter) => waiter.type === type);
    if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1);
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    this.child.kill("SIGKILL");
    await exited;
  }

  private dispatch(message: ChildMessage): void {
    const index = this.waiters.findIndex((waiter) => waiter.type === message.type);
    if (index < 0) {
      this.queued.push(message);
      return;
    }
    const [waiter] = this.waiters.splice(index, 1);
    waiter.resolve(message);
  }

  private rejectAll(error: Error): void {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}

describe("cross-process datastore writes", () => {
  let tempDirectory: string;
  let dataPath: string;
  let originalDataPath: string | undefined;
  let children: ChildController[];

  beforeEach(async () => {
    originalDataPath = process.env.TILBUDSTROLDEN_DATA;
    tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "tilbudstrolden-lock-"));
    dataPath = path.join(tempDirectory, "data.json");
    process.env.TILBUDSTROLDEN_DATA = dataPath;
    children = [];
  });

  afterEach(async () => {
    await Promise.all(children.map((child) => child.stop()));
    if (originalDataPath === undefined) delete process.env.TILBUDSTROLDEN_DATA;
    else process.env.TILBUDSTROLDEN_DATA = originalDataPath;
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  function child(): ChildController {
    const controller = new ChildController(dataPath);
    children.push(controller);
    return controller;
  }

  it("fails closed without TILBUDSTROLDEN_DATA", async () => {
    const isolatedHome = path.join(tempDirectory, "isolated-home");
    await fs.mkdir(isolatedHome);
    const env = { ...process.env, HOME: isolatedHome };
    delete env.TILBUDSTROLDEN_DATA;

    const result = await runFixtureUntilExit(env);

    expect(result.code).not.toBe(0);
    expect(result.messages).toEqual([]);
    expect(result.stderr).toContain("TILBUDSTROLDEN_DATA is required");
    await expect(fs.stat(path.join(isolatedHome, ".tilbudstrolden.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.stat(path.join(isolatedHome, ".tilbudstrolden.json.lock")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed when the datastore path is outside the child temp root", async () => {
    const childTempRoot = path.join(tempDirectory, "allowed-temp");
    const unsafePath = path.join(tempDirectory, "outside-temp", "data.json");
    await fs.mkdir(childTempRoot);

    const result = await runFixtureUntilExit({
      ...process.env,
      TMPDIR: childTempRoot,
      TILBUDSTROLDEN_DATA: unsafePath,
    });

    expect(result.code).not.toBe(0);
    expect(result.messages).toEqual([]);
    expect(result.stderr).toContain("datastore path must be inside the system temp directory");
    await expect(fs.stat(unsafePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${unsafePath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes two writers and preserves both mutations", async () => {
    await store.save(makeStore());
    const writerA = child();
    writerA.send({ type: "modify", pantryItem: "Salt", hold: true });
    await writerA.waitFor("inside");

    const writerB = child();
    writerB.send({ type: "modify", country: "NO" });
    await writerB.waitFor("starting");
    await writerB.expectNoMessage("inside");

    writerA.send({ type: "continue" });
    await writerA.waitFor("done");
    await writerB.waitFor("inside");
    await writerB.waitFor("done");

    await expect(store.load()).resolves.toMatchObject({
      household: { country: "NO" },
      pantry: ["Salt"],
    });
  });

  it("prevents a lost update between independent writers", async () => {
    await store.save(makeStore());
    const writerA = child();
    const writerB = child();
    writerA.send({ type: "modify", pantryItem: "Salt", hold: true });
    await writerA.waitFor("inside");
    writerB.send({ type: "modify", country: "SE" });
    await writerB.waitFor("starting");
    writerA.send({ type: "continue" });

    await Promise.all([writerA.waitFor("done"), writerB.waitFor("done")]);
    const data = await store.load();
    expect(data.pantry).toContain("Salt");
    expect(data.household.country).toBe("SE");
  });

  it("releases the kernel lock after SIGKILL without deleting the sidecar", async () => {
    await store.save(makeStore());
    const holder = child();
    holder.send({ type: "modify", pantryItem: "Never committed", hold: true });
    await holder.waitFor("inside");
    await expect(fs.stat(`${dataPath}.lock`)).resolves.toBeDefined();

    await holder.stop();
    const successor = child();
    successor.send({ type: "modify", pantryItem: "Recovered" });
    await successor.waitFor("done");

    expect((await store.load()).pantry).toEqual(["Recovered"]);
    await expect(fs.stat(`${dataPath}.lock`)).resolves.toBeDefined();
  });

  it("times out with a typed busy error before running the callback", async () => {
    await store.save(makeStore());
    const holder = child();
    holder.send({ type: "modify", pantryItem: "Holder", hold: true });
    await holder.waitFor("inside");

    const blocked = child();
    blocked.send({ type: "modify", pantryItem: "Must not run" });
    await blocked.waitFor("starting");
    const startedAt = performance.now();
    const error = await blocked.waitFor("error");
    const elapsed = performance.now() - startedAt;

    expect(error).toMatchObject({
      name: "DatastoreBusyError",
      code: "DATASTORE_BUSY",
      callbackRan: false,
    });
    expect(elapsed).toBeGreaterThanOrEqual(2900);
    expect(elapsed).toBeLessThan(4500);
    expect((await store.load()).pantry).toEqual([]);

    holder.send({ type: "continue" });
    await holder.waitFor("done");
  }, 10_000);

  it("serializes first-run writers into valid JSON without temporary leftovers", async () => {
    const writerA = child();
    writerA.send({ type: "modify", pantryItem: "Salt", hold: true });
    await writerA.waitFor("inside");
    const writerB = child();
    writerB.send({ type: "modify", country: "FI" });
    await writerB.waitFor("starting");
    writerA.send({ type: "continue" });
    await Promise.all([writerA.waitFor("done"), writerB.waitFor("done")]);

    const raw = await fs.readFile(dataPath, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
    await expect(store.load()).resolves.toMatchObject({
      household: { country: "FI" },
      pantry: ["Salt"],
    });
    expect((await fs.readdir(tempDirectory)).sort()).toEqual(["data.json", "data.json.lock"]);
  });

  it("rechecks recipe seeding against the latest state under the writer lock", async () => {
    await store.save(makeStore());
    const seeder = child();
    seeder.send({ type: "get-recipes", pauseAfterInitialRead: true });
    await seeder.waitFor("initial-read");

    const recipe = makeRecipe("Concurrent recipe");
    const writer = child();
    writer.send({ type: "add-recipe", recipe });
    await writer.waitFor("done");

    seeder.send({ type: "continue" });
    const result = await seeder.waitFor("done");
    expect(result.recipeNames).toEqual([recipe.name]);
    expect((await store.load()).recipes).toEqual([recipe]);
  });
});
