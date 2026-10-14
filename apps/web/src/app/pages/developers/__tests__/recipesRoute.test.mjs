// Recipes as pages (docs/recipesModel.ts): every recipe has its own path, unknown ids land on the index, and
// nothing reads the old #recipe- state. Run with Node 22.18 or later:
//   node --test apps/web/src/app/pages/developers/__tests__/recipesRoute.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PORTAL_RECIPES } from "../../../routes/routeTable.ts";
import { RECIPES } from "../../../site/snippets.ts";
import { filterRecipes, ORDERED_RECIPES, recipeHref, resolveRecipe } from "../docs/recipesModel.ts";
import { matchPortal } from "../shell/portalRoutes.ts";

test("every recipe id resolves to its own page, with neighbours in index order", () => {
  assert.equal(ORDERED_RECIPES.length, RECIPES.length);
  for (const recipe of RECIPES) {
    const route = resolveRecipe(recipe.id);
    assert.equal(route.view, "recipe", recipe.id);
    assert.equal(route.recipe.id, recipe.id);
    const match = matchPortal(recipeHref(recipe.id));
    assert.equal(match.page.id, "recipes", recipe.id);
    assert.equal(match.param, recipe.id);
  }
  const first = resolveRecipe(ORDERED_RECIPES[0].id);
  assert.equal(first.previous, null);
  assert.equal(first.next.id, ORDERED_RECIPES[1].id);
  const last = resolveRecipe(ORDERED_RECIPES.at(-1).id);
  assert.equal(last.next, null);
});

test("the route table's recipe pages and the journey and questions recipes all resolve", () => {
  for (const recipe of PORTAL_RECIPES) assert.equal(resolveRecipe(recipe.id).view, "recipe", recipe.id);
  for (const id of ["journey", "questions"]) assert.equal(resolveRecipe(id).view, "recipe", id);
});

test("no id shows the index; an unknown id shows the index and names it", () => {
  assert.deepEqual(resolveRecipe(null), { view: "index", unknown: null });
  assert.deepEqual(resolveRecipe(""), { view: "index", unknown: null });
  assert.deepEqual(resolveRecipe("nope"), { view: "index", unknown: "nope" });
});

test("the filter narrows cards by words and drops empty groups", () => {
  assert.equal(filterRecipes("").reduce((total, group) => total + group.recipes.length, 0), RECIPES.length);
  const workers = filterRecipes("worker.ts").flatMap((group) => group.recipes.map((recipe) => recipe.id));
  assert.deepEqual(workers, ["hono"]);
  const questions = filterRecipes("clarifying").flatMap((group) => group.recipes.map((recipe) => recipe.id));
  assert.deepEqual(questions, ["questions"]);
  assert.deepEqual(filterRecipes("zzzz-nothing"), []);
});

test("recipes keep no hash state", () => {
  for (const file of ["../RecipesSection.tsx", "../docs/RecipePage.tsx", "../docs/RecipesIndexPage.tsx", "../views/RecipesPage.tsx"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /location\.hash|#recipe-|AnchorScope|useRoute/u, file);
  }
});
