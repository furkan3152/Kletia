import { ArrowLeft, ArrowRight } from "lucide-react";

import { Link } from "../../../routes/Link";
import type { Recipe } from "../../../site/snippets";
import { cx, FOCUS_RING, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { RecipeView } from "../RecipesSection";
import { PortalPageHeader } from "../shell/PortalPageHeader";
import { RECIPES_PATH, recipeHref } from "./recipesModel";

const NEIGHBOUR = cx(
  "flex min-h-11 min-w-0 flex-1 flex-col gap-0.5 border-2 border-line px-3 py-2 text-sm hover:bg-surface-2 sm:max-w-xs",
  FOCUS_RING,
);

/** One recipe (`/developers/recipes/<id>`): its own H1 and URL, the code, and the way to the neighbours and the index. */
export function RecipePage({ recipe, previous, next }: { readonly recipe: Recipe; readonly previous: Recipe | null; readonly next: Recipe | null }) {
  return (
    <>
      <PortalPageHeader
        back={{ label: "All recipes", to: RECIPES_PATH }}
        eyebrow={<p className={cx(LABEL, "text-accent-text")}>{recipe.group}</p>}
        title={recipe.title}
        intro={recipe.summary}
      />
      <RecipeView recipe={recipe} />
      <nav aria-label="More recipes" className="mt-12 flex min-w-0 flex-col gap-3 border-t-2 border-line pt-6 sm:flex-row sm:justify-between">
        {previous ? (
          <Link to={recipeHref(previous.id)} className={NEIGHBOUR}>
            <span className={cx("inline-flex items-center gap-1 text-xs font-bold", TEXT_MUTED)}>
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              Previous
            </span>
            <span className="font-bold">{previous.label}</span>
          </Link>
        ) : (
          <span className="hidden sm:block" />
        )}
        {next ? (
          <Link to={recipeHref(next.id)} className={cx(NEIGHBOUR, "sm:items-end sm:text-right")}>
            <span className={cx("inline-flex items-center gap-1 text-xs font-bold", TEXT_MUTED)}>
              Next
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            <span className="font-bold">{next.label}</span>
          </Link>
        ) : null}
      </nav>
    </>
  );
}
