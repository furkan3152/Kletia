import { RecipePage } from "../docs/RecipePage";
import { RecipesIndexPage } from "../docs/RecipesIndexPage";
import { resolveRecipe } from "../docs/recipesModel";
import type { PortalPageProps } from "../shell/portalRoutes";

/**
 * Recipes (`/developers/recipes`, `/developers/recipes/<id>`): the index, or
 * the one recipe the path names. An unknown id shows the index with a note.
 */
export default function RecipesPage({ param }: PortalPageProps) {
  const route = resolveRecipe(param);
  return route.view === "recipe" ? (
    <RecipePage key={route.recipe.id} recipe={route.recipe} previous={route.previous} next={route.next} />
  ) : (
    <RecipesIndexPage unknown={route.unknown} />
  );
}
