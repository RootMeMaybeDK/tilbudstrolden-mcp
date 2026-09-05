import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { DataStore, Recipe } from "../../src/store.js";

function rejectUnsafeDatastorePath(message: string): never {
  throw new Error(`Unsafe datastore test fixture configuration: ${message}`);
}

function requireSafeDatastorePath(): void {
  const value = process.env.TILBUDSTROLDEN_DATA;
  if (!value) rejectUnsafeDatastorePath("TILBUDSTROLDEN_DATA is required");
  if (!path.isAbsolute(value)) rejectUnsafeDatastorePath("datastore path must be absolute");

  const resolved = path.resolve(value);
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, resolved);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    rejectUnsafeDatastorePath("datastore path must be inside the system temp directory");
  }
}

requireSafeDatastorePath();
const store = await import("../../src/store.js");

interface ModifyCommand {
  type: "modify";
  pantryItem?: string;
  country?: string;
  recipe?: Recipe;
  hold?: boolean;
}

interface AddRecipeCommand {
  type: "add-recipe";
  recipe: Recipe;
}

interface GetRecipesCommand {
  type: "get-recipes";
  pauseAfterInitialRead?: boolean;
}

type Command = ModifyCommand | AddRecipeCommand | GetRecipesCommand;

let callbackRan = false;

function send(message: Record<string, unknown>): void {
  process.send?.(message);
}

function waitForContinue(): Promise<void> {
  return new Promise((resolve) => {
    const listener = (message: unknown): void => {
      if (
        typeof message === "object" &&
        message !== null &&
        (message as { type?: unknown }).type === "continue"
      ) {
        process.off("message", listener);
        resolve();
      }
    };
    process.on("message", listener);
  });
}

function applyMutation(data: DataStore, command: ModifyCommand): DataStore {
  if (command.pantryItem) data.pantry.push(command.pantryItem);
  if (command.country) data.household.country = command.country;
  if (command.recipe) data.recipes.push(command.recipe);
  return data;
}

async function run(command: Command): Promise<void> {
  if (command.type === "modify") {
    await store.modify(async (data) => {
      callbackRan = true;
      send({ type: "inside" });
      if (command.hold) await waitForContinue();
      return applyMutation(data, command);
    });
    send({ type: "done" });
    return;
  }

  if (command.type === "add-recipe") {
    await store.addRecipe(command.recipe);
    send({ type: "done" });
    return;
  }

  if (command.pauseAfterInitialRead) {
    const originalReadFile = await import("node:fs/promises").then((module) => module.default.readFile);
    let initialReadFinished = false;
    const fsPromises = await import("node:fs/promises");
    Object.defineProperty(fsPromises.default, "readFile", {
      configurable: true,
      value: async (...args: Parameters<typeof originalReadFile>) => {
        const result = await originalReadFile(...args);
        if (!initialReadFinished) {
          initialReadFinished = true;
          send({ type: "initial-read" });
          await waitForContinue();
        }
        return result;
      },
    });
  }
  const recipes = await store.getRecipes();
  send({ type: "done", recipeNames: recipes.map((recipe) => recipe.name) });
}

process.once("message", (message: unknown) => {
  send({ type: "starting" });
  void run(message as Command)
    .catch((error: unknown) => {
      const typed = error as Error & { code?: string };
      send({
        type: "error",
        name: typed.name,
        code: typed.code,
        message: typed.message,
        callbackRan,
      });
    })
    .finally(() => process.disconnect());
});
