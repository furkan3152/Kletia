import { Check } from "lucide-react";
import React, { useRef, useState } from "react";

import { useRoute } from "../../routes/useRoute";
import { useChangeKey } from "../../site/motion/useChangeKey";
import { EMBED_ATTRIBUTES, EMBED_EVENTS, MCP_TOOLS, RECIPES, type Recipe, type RecipeGroup } from "../../site/snippets";
import { CodeBlock } from "../../site/ui/CodeBlock";
import { CopyButton } from "../../site/ui/CopyButton";
import { cx, FOCUS_RING, INK_BORDER, INK_BORDER_THIN, LABEL, SURFACE, TEXT_MUTED } from "../../site/ui/styles";
import { nextTabIndex } from "../../site/ui/tabKeys";

const RECIPE_HASH = /^#recipe-([a-z0-9-]+)$/u;
/** Older links (#embed) still land on the matching recipe. */
const HASH_ALIASES: Readonly<Record<string, string>> = { "#embed": "web-component" };

function recipeFromHash(hash: string): string | null {
  const id = RECIPE_HASH.exec(hash)?.[1] ?? HASH_ALIASES[hash] ?? null;
  return id && RECIPES.some((recipe) => recipe.id === id) ? id : null;
}
const GROUPS: readonly RecipeGroup[] = ["Browser", "Server", "Agents and tools"];

function ReferenceTable({ title, rows }: { title: string; rows: readonly { name: string; values: string; description: string }[] }) {
  return (
    <div className={cx("min-w-0 p-4", INK_BORDER_THIN)}>
      <p className={cx(LABEL, "mb-3")}>{title}</p>
      <dl className="flex flex-col gap-2.5 text-sm">
        {rows.map((row) => (
          <div key={row.name} className="grid gap-1 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-3">
            <dt className="break-words font-code text-[12.5px] font-bold">{row.name}</dt>
            <dd className={cx("min-w-0", TEXT_MUTED)}>
              <span className="break-words font-code text-xs text-[#1A1A1A] dark:text-white">{row.values}</span>
              <span className="block">{row.description}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function RecipeExtras({ recipe }: { recipe: Recipe }) {
  if (recipe.id === "web-component") {
    return (
      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        <ReferenceTable title="Attributes" rows={EMBED_ATTRIBUTES} />
        <ReferenceTable
          title="Events"
          rows={EMBED_EVENTS.map((event) => ({ name: event.name, values: `detail: ${event.detail}`, description: event.description }))}
        />
      </div>
    );
  }
  if (recipe.id === "mcp") {
    return (
      <div className={cx("min-w-0 p-4", INK_BORDER_THIN)}>
        <p className={cx(LABEL, "mb-3")}>Tools (all read-only)</p>
        <ul className="grid gap-x-6 gap-y-2.5 text-sm md:grid-cols-2">
          {MCP_TOOLS.map((tool) => (
            <li key={tool.name} className="min-w-0">
              <code className="font-code text-[12.5px] font-bold">{tool.name}</code>
              <span className={cx("ml-2 font-code text-[11px]", TEXT_MUTED)}>({tool.input})</span>
              <span className={cx("block", TEXT_MUTED)}>{tool.output}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return null;
}

/** Integration recipes: a recipe picker (deep links: #recipe-<id>) and copyable, checked code. */
export function RecipesSection() {
  const { location } = useRoute();
  const fromHash = recipeFromHash(location.hash);
  const [activeId, setActiveId] = useState(() => fromHash ?? RECIPES[0]!.id);
  const [seenLocation, setSeenLocation] = useState(location.key);
  if (seenLocation !== location.key) {
    setSeenLocation(location.key);
    if (fromHash && fromHash !== activeId) setActiveId(fromHash);
  }
  const recipe = RECIPES.find((item) => item.id === activeId) ?? RECIPES[0]!;
  const swapKey = useChangeKey(recipe.id);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = nextTabIndex(event.key, index, RECIPES.length);
    if (next === null) return;
    event.preventDefault();
    setActiveId(RECIPES[next]!.id);
    tabRefs.current[next]?.focus();
  };

  return (
    <div id="embed" className={cx("grid min-w-0 scroll-mt-36 lg:scroll-mt-28 lg:grid-cols-[13rem_minmax(0,1fr)]", INK_BORDER, SURFACE)}>
      <div
        role="tablist"
        aria-label="Recipes"
        className="flex min-w-0 gap-1 overflow-x-auto border-b-[3px] border-[#1A1A1A] bg-[#F1EFE8] p-2 dark:border-[#4B5563] dark:bg-[#0F1A2C] lg:flex-col lg:overflow-visible lg:border-b-0 lg:border-r-[3px] lg:p-3"
      >
        {GROUPS.map((group) => {
          const items = RECIPES.filter((item) => item.group === group);
          return (
            <React.Fragment key={group}>
              <p className={cx(LABEL, "hidden px-2 pb-1 pt-3 !text-[10px] first:pt-0 lg:block", TEXT_MUTED)} aria-hidden="true">
                {group}
              </p>
              {items.map((item) => {
                const index = RECIPES.indexOf(item);
                const selected = item.id === recipe.id;
                return (
                  <button
                    key={item.id}
                    ref={(element) => {
                      tabRefs.current[index] = element;
                    }}
                    type="button"
                    role="tab"
                    id={`recipe-tab-${item.id}`}
                    aria-selected={selected}
                    aria-controls="recipe-panel"
                    tabIndex={selected ? 0 : -1}
                    onClick={() => setActiveId(item.id)}
                    onKeyDown={(event) => onKeyDown(event, index)}
                    className={cx(
                      "flex min-h-10 shrink-0 items-center whitespace-nowrap border-2 px-3 text-left text-sm font-bold transition-colors",
                      selected
                        ? "border-[#1A1A1A] bg-[#1A1A1A] text-white dark:border-[#FFD60A] dark:bg-[#FFD60A] dark:text-[#1A1A1A]"
                        : "border-transparent hover:border-[#1A1A1A] hover:bg-white dark:hover:border-[#4B5563] dark:hover:bg-[#131E32]",
                      FOCUS_RING,
                    )}
                  >
                    {item.label}
                  </button>
                );
              })}
            </React.Fragment>
          );
        })}
      </div>

      <div id="recipe-panel" role="tabpanel" aria-labelledby={`recipe-tab-${recipe.id}`} className="flex min-w-0 flex-col gap-5 p-4 sm:p-6">
        <div key={swapKey} className={cx("flex min-w-0 flex-col gap-5", swapKey > 0 && "kl-rise")}>
          <header className="flex min-w-0 flex-col gap-2">
            <p className={cx(LABEL, "text-[#0052FF] dark:text-[#7EA6FF]")}>{recipe.group}</p>
            <h3 id={`recipe-${recipe.id}`} className="scroll-mt-40 font-display lg:scroll-mt-28 text-2xl font-bold tracking-[-0.02em]">
              {recipe.title}
            </h3>
            <p className={cx("max-w-3xl text-sm leading-relaxed", TEXT_MUTED)}>{recipe.summary}</p>
          </header>
          {recipe.install ? (
            <div className="flex min-w-0 items-center gap-2 border-[3px] border-[#1A1A1A] bg-[#0D1117] py-1.5 pl-3 pr-1.5 text-[#E6EDF3] dark:border-[#4B5563]">
              <code className="min-w-0 flex-1 break-words font-code text-[12.5px]">
                <span className="text-[#FFD60A]">$</span> {recipe.install}
              </code>
              <CopyButton text={recipe.install} label={`Copy install command for ${recipe.label}`} />
            </div>
          ) : null}
          {recipe.files.length > 1 ? (
            <CodeBlock
              tabs={recipe.files.map((file) => ({ id: file.id, label: file.label, language: file.language, code: file.code, filename: file.filename }))}
              label={`${recipe.label} code`}
              maxHeightClassName="max-h-[34rem]"
            />
          ) : recipe.files[0] ? (
            <CodeBlock
              code={recipe.files[0].code}
              language={recipe.files[0].language}
              filename={recipe.files[0].filename}
              label={`${recipe.label} code`}
              maxHeightClassName="max-h-[34rem]"
            />
          ) : null}
          <RecipeExtras recipe={recipe} />
          <ul className="flex flex-col gap-2">
            {recipe.notes.map((note) => (
              <li key={note} className="flex gap-2 text-sm leading-relaxed">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-[#0052FF] dark:text-[#7EA6FF]" aria-hidden="true" />
                <span>{note}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
