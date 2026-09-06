import { describe, expect, it, vi } from "vitest";
import {
  HTTP_BASE,
  jsonRequest,
  makeHttpRecipe,
  makeHttpStore,
  useHttpDatastore,
} from "../../test/http-fixtures.js";
import { defaultRecipes } from "../default-recipes.js";
import * as store from "../store.js";
import { createHttpApp } from "./app.js";

describe("recipe HTTP routes", () => {
  useHttpDatastore();
  const request = (route: string, init?: RequestInit) =>
    createHttpApp().request(`${HTTP_BASE}${route}`, init);
  const minimal = {
    name: "New",
    complexity: "quick",
    cuisineType: "danish",
    proteinType: "vegetarian",
    ingredients: [{ name: "LØG", quantity: "2 stk" }],
  };

  it("reads structured recipes", async () => {
    const res = await request("/api/recipes");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recipes: [makeHttpRecipe()] });
  });

  it("saves minimal input with service defaults and a neutral 200 saved result", async () => {
    const get = vi.spyOn(store, "getRecipes");
    const res = await request("/api/recipes", jsonRequest(minimal));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "saved",
      recipe: {
        ...minimal,
        servings: 4,
        ingredients: [{ name: "LØG", quantity: "2 stk", searchTerms: ["løg"], category: "other" }],
      },
    });
    expect(get).not.toHaveBeenCalled();
    expect((await store.load()).recipes.map((r) => r.name)).toEqual(["Chili", "New"]);
  });

  it("preserves raw input, duplicates, empty elements, zero servings and ingredient order", async () => {
    const body = {
      ...minimal,
      name: " raw ",
      servings: 0,
      cuisineType: " raw ",
      proteinType: " raw ",
      ingredients: [
        {
          name: " Løg ",
          quantity: " ca. 3-4 stk + 1 dl ",
          searchTerms: ["", " LØG ", " LØG "],
          category: "   ",
        },
        { name: " Løg ", quantity: "2 fed", searchTerms: [], category: "" },
      ],
    };
    const res = await request("/api/recipes", jsonRequest(body));
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.recipe).toEqual({
      ...body,
      ingredients: [
        body.ingredients[0],
        { ...body.ingredients[1], searchTerms: [" løg "], category: "other" },
      ],
    });
    expect((await store.load()).recipes[1]).toEqual(result.recipe);
  });

  it("accepts empty names, empty ingredients and negative servings as before", async () => {
    const res = await request(
      "/api/recipes",
      jsonRequest({ ...minimal, name: "", servings: -1, ingredients: [] }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).recipe).toMatchObject({ name: "", servings: -1, ingredients: [] });
  });

  it("upserts only the first case-insensitive match without moving its position", async () => {
    await store.save(
      makeHttpStore({
        recipes: [
          makeHttpRecipe({ name: "First" }),
          makeHttpRecipe(),
          makeHttpRecipe({ name: "CHILI", servings: 9 }),
        ],
      }),
    );
    for (const servings of [2, 5]) {
      const res = await request(
        "/api/recipes",
        jsonRequest({ ...minimal, name: "chili", servings }),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("saved");
    }
    expect((await store.load()).recipes.map(({ name, servings }) => ({ name, servings }))).toEqual([
      { name: "First", servings: 4 },
      { name: "chili", servings: 5 },
      { name: "CHILI", servings: 9 },
    ]);
  });

  it("deletes case-insensitively and returns a stable structured outcome", async () => {
    const res = await request("/api/recipes/cHiLi", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "removed", requestedName: "cHiLi" });
    expect((await store.load()).recipes).toEqual([]);
  });

  it("decodes encoded names exactly once, including slash, plus, Unicode and literal %20", async () => {
    const name = " Æg / ris + %20 ";
    await store.save(makeHttpStore({ recipes: [makeHttpRecipe({ name })] }));
    const res = await request(`/api/recipes/${encodeURIComponent(name)}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "removed", requestedName: name });
    expect((await store.load()).recipes).toEqual([]);
  });

  it("returns 404 for missing/untrimmed names while retaining the store write", async () => {
    const get = vi.spyOn(store, "getRecipes");
    const remove = vi.spyOn(store, "removeRecipe");
    const res = await request(`/api/recipes/${encodeURIComponent(" Chili ")}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "RECIPE_NOT_FOUND", message: "Recipe not found." },
    });
    expect(remove).toHaveBeenCalledExactlyOnceWith(" Chili ");
    expect(get).not.toHaveBeenCalled();
  });

  it("leaves deleted DK recipes empty until GET delegates default seeding", async () => {
    await request("/api/recipes/Chili", { method: "DELETE" });
    expect((await store.load()).recipes).toEqual([]);
    const res = await request("/api/recipes");
    expect(await res.json()).toEqual({ recipes: defaultRecipes });
    expect((await store.load()).recipes).toEqual(defaultRecipes);
  });

  it("does not seed a non-DK library", async () => {
    const data = makeHttpStore({ recipes: [] });
    data.household.country = "NO";
    await store.save(data);
    expect(await (await request("/api/recipes")).json()).toEqual({ recipes: [] });
  });

  it("rejects invalid wire types without invoking mutation", async () => {
    const add = vi.spyOn(store, "addRecipe");
    const res = await request(
      "/api/recipes",
      jsonRequest({ ...minimal, ingredients: [{ name: "Løg", quantity: 2 }] }),
    );
    expect(res.status).toBe(400);
    expect(add).not.toHaveBeenCalled();
  });

  it("maps unexpected store errors without leaking their details", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(store, "addRecipe").mockRejectedValueOnce(new Error("private/path/permission"));
    const res = await request("/api/recipes", jsonRequest(minimal));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "The request could not be completed." },
    });
  });
});
