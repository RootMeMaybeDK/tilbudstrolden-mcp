import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataStore, Recipe } from "../store.js";
import * as store from "../store.js";
import { removeRecipeByName, type SaveRecipeInput, saveRecipe } from "./recipe-service.js";

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    name: "Chili",
    servings: 4,
    complexity: "medium",
    cuisineType: "mexican",
    proteinType: "beef",
    ingredients: [
      {
        name: "Hakket oksekød",
        quantity: "500 g",
        searchTerms: ["hakket oksekød"],
        category: "other",
      },
    ],
    ...overrides,
  };
}

function makeInput(overrides: Partial<SaveRecipeInput> = {}): SaveRecipeInput {
  return {
    name: "Chili",
    complexity: "medium",
    cuisineType: "mexican",
    proteinType: "beef",
    ingredients: [{ name: "Hakket oksekød", quantity: "500 g" }],
    ...overrides,
  };
}

function makeStore(recipes: Recipe[] = [], country = "DK"): DataStore {
  return {
    household: { people: [], stores: [], defaultServings: 2, country },
    pantry: [],
    recipes,
    mealHistory: [],
    spendLog: [],
  };
}

describe("recipe mutation service", () => {
  let tempDirectory: string;
  let originalDataPath: string | undefined;

  beforeEach(async () => {
    originalDataPath = process.env.TILBUDSTROLDEN_DATA;
    tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "tilbudstrolden-recipe-service-"));
    process.env.TILBUDSTROLDEN_DATA = path.join(tempDirectory, "data.json");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalDataPath === undefined) delete process.env.TILBUDSTROLDEN_DATA;
    else process.env.TILBUDSTROLDEN_DATA = originalDataPath;
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  describe("saveRecipe", () => {
    it("applies the servings, search-term, and category defaults", async () => {
      const result = await saveRecipe(makeInput());

      expect(result).toEqual({
        status: "saved",
        recipe: makeRecipe(),
      });
      await expect(store.load()).resolves.toEqual(makeStore([makeRecipe()]));
    });

    it.each([0, 2, -1])("preserves an explicit servings value of %s", async (servings) => {
      const result = await saveRecipe(makeInput({ servings }));

      expect(result.recipe.servings).toBe(servings);
    });

    it("treats empty search terms and an empty category as missing", async () => {
      const result = await saveRecipe(
        makeInput({
          ingredients: [{ name: "LØG", quantity: "2 stk", searchTerms: [], category: "" }],
        }),
      );

      expect(result.recipe.ingredients).toEqual([
        {
          name: "LØG",
          quantity: "2 stk",
          searchTerms: ["løg"],
          category: "other",
        },
      ]);
    });

    it("preserves non-empty search terms exactly, including duplicates and empty entries", async () => {
      const searchTerms = ["", " Beef ", " Beef "];
      const result = await saveRecipe(
        makeInput({
          ingredients: [
            {
              name: "Beef",
              quantity: "ca. 3-4 stk / 500 g",
              searchTerms,
              category: "   ",
            },
          ],
        }),
      );

      expect(result.recipe.ingredients[0]).toEqual({
        name: "Beef",
        quantity: "ca. 3-4 stk / 500 g",
        searchTerms: ["", " Beef ", " Beef "],
        category: "   ",
      });
      expect(searchTerms).toEqual(["", " Beef ", " Beef "]);
      expect(result.recipe.ingredients[0].searchTerms).toBe(searchTerms);
    });

    it("preserves empty and duplicate ingredients in their original order", async () => {
      const ingredients = [
        { name: "Salt", quantity: " efter smag " },
        { name: "Peber", quantity: "1 tsk" },
        { name: "Salt", quantity: "2 tsk" },
      ];
      const empty = await saveRecipe(makeInput({ ingredients: [] }));
      const duplicated = await saveRecipe(makeInput({ name: "Duplicate", ingredients }));

      expect(empty.recipe.ingredients).toEqual([]);
      expect(duplicated.recipe.ingredients.map((ingredient) => ingredient.name)).toEqual([
        "Salt",
        "Peber",
        "Salt",
      ]);
      expect(duplicated.recipe.ingredients.map((ingredient) => ingredient.quantity)).toEqual([
        " efter smag ",
        "1 tsk",
        "2 tsk",
      ]);
    });

    it("does not trim recipe or ingredient text fields", async () => {
      const result = await saveRecipe(
        makeInput({
          name: " Recipe ",
          cuisineType: " cuisine ",
          proteinType: " protein ",
          ingredients: [{ name: " Ingredient ", quantity: " 1 stk " }],
        }),
      );

      expect(result.recipe).toMatchObject({
        name: " Recipe ",
        cuisineType: " cuisine ",
        proteinType: " protein ",
        ingredients: [
          {
            name: " Ingredient ",
            quantity: " 1 stk ",
            searchTerms: [" ingredient "],
          },
        ],
      });
    });

    it("appends a recipe when no case-insensitive match exists", async () => {
      await store.save(makeStore([makeRecipe({ name: "First" })]));

      await saveRecipe(makeInput({ name: "Second" }));

      expect((await store.load()).recipes.map((recipe) => recipe.name)).toEqual([
        "First",
        "Second",
      ]);
    });

    it("replaces the first case-insensitive match in the same position", async () => {
      await store.save(
        makeStore([
          makeRecipe({ name: "First" }),
          makeRecipe({ name: "CHILI", servings: 8 }),
          makeRecipe({ name: "Last" }),
        ]),
      );

      await saveRecipe(makeInput({ name: "chili", servings: 2 }));

      const recipes = (await store.load()).recipes;
      expect(recipes.map((recipe) => recipe.name)).toEqual(["First", "chili", "Last"]);
      expect(recipes[1].servings).toBe(2);
    });

    it("replaces only the first match when case-insensitive duplicates already exist", async () => {
      await store.save(
        makeStore([
          makeRecipe({ name: "Chili", servings: 1 }),
          makeRecipe({ name: "CHILI", servings: 2 }),
          makeRecipe({ name: "Last" }),
        ]),
      );

      await saveRecipe(makeInput({ name: "chili", servings: 3 }));

      const recipes = (await store.load()).recipes;
      expect(recipes.map(({ name, servings }) => ({ name, servings }))).toEqual([
        { name: "chili", servings: 3 },
        { name: "CHILI", servings: 2 },
        { name: "Last", servings: 4 },
      ]);
    });

    it("does not pre-read recipes before delegating the upsert", async () => {
      const getRecipes = vi.spyOn(store, "getRecipes");

      await saveRecipe(makeInput());

      expect(getRecipes).not.toHaveBeenCalled();
    });

    it("propagates the exact addRecipe error object", async () => {
      const error = new Error("datastore busy");
      vi.spyOn(store, "addRecipe").mockRejectedValueOnce(error);

      await expect(saveRecipe(makeInput())).rejects.toBe(error);
    });
  });

  describe("removeRecipeByName", () => {
    it.each(["Chili", "cHiLi"])("removes an existing recipe for %j", async (name) => {
      await store.save(
        makeStore([
          makeRecipe({ name: "First" }),
          makeRecipe({ name: "Chili" }),
          makeRecipe({ name: "Last" }),
        ]),
      );

      await expect(removeRecipeByName(name)).resolves.toEqual({
        status: "removed",
        requestedName: name,
      });
      expect((await store.load()).recipes.map((recipe) => recipe.name)).toEqual(["First", "Last"]);
    });

    it("does not trim the requested name and still calls the store on not-found", async () => {
      await store.save(makeStore([makeRecipe()]));
      const removeRecipe = vi.spyOn(store, "removeRecipe");

      await expect(removeRecipeByName(" Chili ")).resolves.toEqual({
        status: "not-found",
        requestedName: " Chili ",
      });
      expect(removeRecipe).toHaveBeenCalledOnce();
      expect(removeRecipe).toHaveBeenCalledWith(" Chili ");
      expect((await store.load()).recipes).toEqual([makeRecipe()]);
    });

    it("removes only the first case-insensitive duplicate", async () => {
      await store.save(
        makeStore([
          makeRecipe({ name: "Chili", servings: 1 }),
          makeRecipe({ name: "CHILI", servings: 2 }),
          makeRecipe({ name: "Last" }),
        ]),
      );

      await removeRecipeByName("chili");

      expect((await store.load()).recipes.map((recipe) => recipe.name)).toEqual(["CHILI", "Last"]);
    });

    it("returns not-found on repeated removal while delegating each attempt", async () => {
      await store.save(makeStore([makeRecipe()]));
      const removeRecipe = vi.spyOn(store, "removeRecipe");

      await expect(removeRecipeByName("Chili")).resolves.toEqual({
        status: "removed",
        requestedName: "Chili",
      });
      await expect(removeRecipeByName("Chili")).resolves.toEqual({
        status: "not-found",
        requestedName: "Chili",
      });
      expect(removeRecipe).toHaveBeenCalledTimes(2);
    });

    it("propagates the exact removeRecipe error object", async () => {
      const error = new Error("permission denied");
      vi.spyOn(store, "removeRecipe").mockRejectedValueOnce(error);

      await expect(removeRecipeByName("Chili")).rejects.toBe(error);
    });

    it("leaves the raw recipe list empty until the next DK getRecipes call seeds defaults", async () => {
      await store.save(makeStore([makeRecipe()]));

      await expect(removeRecipeByName("Chili")).resolves.toMatchObject({ status: "removed" });
      await expect(store.load()).resolves.toMatchObject({ recipes: [] });

      const seeded = await store.getRecipes();
      expect(seeded.length).toBeGreaterThan(0);
      await expect(store.load()).resolves.toMatchObject({ recipes: seeded });
    });
  });
});
