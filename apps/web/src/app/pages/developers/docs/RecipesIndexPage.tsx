import { Search, X } from "lucide-react";
import { useDeferredValue, useId, useState } from "react";

import { Link } from "../../../routes/Link";
import { Icon } from "../../../site/art/Icon";
import { cx, FOCUS_RING, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { PortalPageHeader } from "../shell/PortalPageHeader";
import { filterRecipes, ORDERED_RECIPES, recipeFacts, recipeHref, recipeIcon } from "./recipesModel";

/**
 * Recipes index (`/developers/recipes`): every recipe as a card in its group,
 * each one its own page. A filter narrows the cards; an unknown recipe id in
 * the path lands here with a note.
 */
export function RecipesIndexPage({ unknown }: { readonly unknown: string | null }) {
  const filterId = useId();
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const groups = filterRecipes(deferred);
  const shown = groups.reduce((total, group) => total + group.recipes.length, 0);

  return (
    <>
      <PortalPageHeader
        title="Recipes"
        intro="Copy-ready integrations for the browser, your server, the platform features and agents. Each recipe is complete: the packages it needs, the files, and the rules that matter in production. Secrets always come from the environment."
      />
      {unknown ? (
        <p role="status" className="mb-6 border-l-[6px] border-warning bg-warning-bg px-4 py-3 text-sm text-fg">
          There is no recipe named <code className="break-all font-code font-bold">{unknown}</code>. Pick one below.
        </p>
      ) : null}
      <div className="mb-8 flex min-w-0 flex-col gap-1.5 sm:max-w-md">
        <label htmlFor={filterId} className={LABEL}>
          Filter recipes
        </label>
        <div className="relative flex min-w-0">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          <input
            id={filterId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="webhook, React, journey…"
            autoComplete="off"
            spellCheck={false}
            className={cx(
              "min-h-11 w-full min-w-0 border-[3px] border-control bg-surface py-2 pl-9 pr-10 text-body text-fg placeholder:text-placeholder",
              FOCUS_RING,
            )}
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear the filter"
              className={cx("absolute right-1 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center", FOCUS_RING)}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <p className={cx("text-xs", TEXT_MUTED)} role="status" aria-live="polite">
          {shown === ORDERED_RECIPES.length ? `${shown} recipes.` : `${shown} of ${ORDERED_RECIPES.length} recipes match.`}
        </p>
      </div>
      {groups.length === 0 ? (
        <p className={cx("border-[3px] border-dashed border-line p-6 text-center text-sm", TEXT_MUTED)}>No recipe matches “{deferred}”.</p>
      ) : (
        <div className="flex min-w-0 flex-col gap-10">
          {groups.map((group) => (
            <section key={group.group} aria-labelledby={`recipes-${group.group.replace(/\W+/gu, "-").toLowerCase()}`} className="flex min-w-0 flex-col gap-4">
              <h2 id={`recipes-${group.group.replace(/\W+/gu, "-").toLowerCase()}`} className="font-display text-title font-bold">
                {group.label}
              </h2>
              <ul className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {group.recipes.map((recipe) => (
                  <li key={recipe.id} className="min-w-0">
                    <Link
                      to={recipeHref(recipe.id)}
                      className={cx("kl-lift group flex h-full min-w-0 flex-col gap-3 p-4 hover:bg-surface-2", INK_BORDER, SURFACE, FOCUS_RING)}
                    >
                      <span className="flex items-center gap-3">
                        <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center border-2 border-line bg-paper">
                          <Icon name={recipeIcon(recipe.id)} size={24} />
                        </span>
                        <span className="min-w-0 font-display text-body font-bold leading-tight group-hover:underline">{recipe.label}</span>
                      </span>
                      <span className={cx("text-sm leading-snug", TEXT_MUTED)}>{recipe.title}</span>
                      <span className={cx("mt-auto font-code text-code-s", TEXT_MUTED)}>{recipeFacts(recipe)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
