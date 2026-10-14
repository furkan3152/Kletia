/**
 * Recipes as pages: `/developers/recipes` is the index and
 * `/developers/recipes/<id>` one recipe, picked from the path alone (no
 * `#recipe-` state). Pure: the node tests load it directly.
 */
import type { IconName } from "../../../site/art/icons.ts";
import { RECIPES, type Recipe, type RecipeGroup } from "../../../site/snippets.ts";

export const RECIPES_PATH = "/developers/recipes";

/** Index order: the groups as the index shows them, recipes in RECIPES order inside each. */
export const RECIPE_GROUPS: readonly { readonly group: RecipeGroup; readonly label: string }[] = [
  { group: "Browser", label: "Browser" },
  { group: "Server", label: "Server" },
  { group: "Platform features", label: "Platform features" },
  { group: "Agents and tools", label: "Agents and tools" },
];

export const ORDERED_RECIPES: readonly Recipe[] = RECIPE_GROUPS.flatMap(({ group }) => RECIPES.filter((recipe) => recipe.group === group));

/** The pictogram on each recipe card (object nouns). */
const RECIPE_ICONS: Readonly<Record<string, IconName>> = {
  "react-widget": "embed",
  "react-hooks": "sdk",
  nextjs: "route",
  express: "webhook",
  hono: "webhook",
  "web-component": "embed",
  iframe: "embed",
  mcp: "board",
  cli: "sdk",
  "mcp-agent": "shield",
  "fare-preview": "ticket",
  "rule-book": "shield",
  contracts: "contract",
  links: "ticket",
  receipts: "verify",
  journey: "route",
  questions: "name",
};

export function recipeIcon(id: string): IconName {
  return RECIPE_ICONS[id] ?? "sdk";
}

export function recipeHref(id: string): string {
  return `${RECIPES_PATH}/${id}`;
}

export type RecipeRoute =
  | { readonly view: "index"; readonly unknown: string | null }
  | { readonly view: "recipe"; readonly recipe: Recipe; readonly previous: Recipe | null; readonly next: Recipe | null };

/** What `/developers/recipes[/<param>]` shows: one recipe, or the index (naming an unknown id when there was one). */
export function resolveRecipe(param: string | null | undefined): RecipeRoute {
  if (!param) return { view: "index", unknown: null };
  const index = ORDERED_RECIPES.findIndex((recipe) => recipe.id === param);
  if (index < 0) return { view: "index", unknown: param };
  return {
    view: "recipe",
    recipe: ORDERED_RECIPES[index]!,
    previous: ORDERED_RECIPES[index - 1] ?? null,
    next: ORDERED_RECIPES[index + 1] ?? null,
  };
}

/** Files and the one-line summary a card shows ("3 files"). */
export function recipeFacts(recipe: Recipe): string {
  const files = recipe.files.length;
  return `${files} ${files === 1 ? "file" : "files"}`;
}

/** The index filtered by a query over title, label, summary, group and file names; groups without a match drop out. */
export function filterRecipes(query: string): readonly { readonly group: RecipeGroup; readonly label: string; readonly recipes: readonly Recipe[] }[] {
  const needle = query.trim().toLowerCase();
  const matches = (recipe: Recipe) =>
    !needle ||
    [recipe.label, recipe.title, recipe.summary, recipe.group, recipe.install ?? "", ...recipe.files.map((file) => file.filename)]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  return RECIPE_GROUPS.map(({ group, label }) => ({ group, label, recipes: ORDERED_RECIPES.filter((recipe) => recipe.group === group && matches(recipe)) })).filter(
    (entry) => entry.recipes.length > 0,
  );
}
