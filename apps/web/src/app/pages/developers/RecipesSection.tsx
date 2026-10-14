import { Check } from "lucide-react";

import { EMBED_ATTRIBUTES, EMBED_EVENTS, MCP_TOOLS, type Recipe } from "../../site/snippets";
import { CodeBlock } from "../../site/ui/CodeBlock";
import { CopyButton } from "../../site/ui/CopyButton";
import { cx, INK_BORDER_THIN, LABEL, TEXT_MUTED } from "../../site/ui/styles";

function ReferenceTable({ title, rows }: { title: string; rows: readonly { name: string; values: string; description: string }[] }) {
  return (
    <div className={cx("min-w-0 p-4", INK_BORDER_THIN)}>
      <h2 className={cx(LABEL, "mb-3")}>{title}</h2>
      <dl className="flex flex-col gap-2.5 text-sm">
        {rows.map((row) => (
          <div key={row.name} className="grid gap-1 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-3">
            <dt className="break-words font-code text-code font-bold">{row.name}</dt>
            <dd className={cx("min-w-0", TEXT_MUTED)}>
              <span className="break-words font-code text-code-s text-fg">{row.values}</span>
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
      // Stacked, not side by side: each table needs the full width for its name column.
      <div className="grid min-w-0 gap-4">
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
        <h2 className={cx(LABEL, "mb-1")}>Tools</h2>
        <p className={cx("mb-3 text-xs", TEXT_MUTED)}>Every tool is read-only except the two marked &ldquo;stores&rdquo;; none prepares, submits or signs.</p>
        <ul className="grid gap-x-6 gap-y-2.5 text-sm md:grid-cols-2">
          {MCP_TOOLS.map((tool) => (
            <li key={tool.name} className="min-w-0">
              <code className="font-code text-code font-bold">{tool.name}</code>
              <span className={cx("ml-2 font-code text-code-s", TEXT_MUTED)}>({tool.input})</span>
              {tool.writes ? <span className="ml-2 border-2 border-current px-1 font-code text-label uppercase">stores</span> : null}
              {tool.key ? <span className={cx("ml-2 font-code text-label uppercase", TEXT_MUTED)}>key</span> : null}
              <span className={cx("block", TEXT_MUTED)}>{tool.output}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return null;
}

/**
 * One recipe's body (`/developers/recipes/<id>`): the install line, its
 * files, the reference tables some recipes carry and the rules that matter
 * in production. The page header, the index and the links between recipes
 * belong to the docs pages; nothing here reads the URL.
 */
export function RecipeView({ recipe }: { readonly recipe: Recipe }) {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      {recipe.install ? (
        <div className="flex min-w-0 items-center gap-2 border-[3px] border-[#1A1A1A] bg-[#0D1117] py-1.5 pl-3 pr-1.5 text-[#E6EDF3] dark:border-[#4B5563]">
          <code className="min-w-0 flex-1 break-words font-code text-code">
            <span className="text-[#FFD60A]">$</span> {recipe.install}
          </code>
          <CopyButton text={recipe.install} label={`Copy install command for ${recipe.label}`} />
        </div>
      ) : null}
      {recipe.files.length > 1 ? (
        <CodeBlock
          tabs={recipe.files.map((file) => ({ id: file.id, label: file.label, language: file.language, code: file.code, filename: file.filename }))}
          label={`${recipe.label} code`}
          maxHeightClassName="max-h-[40rem]"
        />
      ) : recipe.files[0] ? (
        <CodeBlock
          code={recipe.files[0].code}
          language={recipe.files[0].language}
          filename={recipe.files[0].filename}
          label={`${recipe.label} code`}
          maxHeightClassName="max-h-[40rem]"
        />
      ) : null}
      <RecipeExtras recipe={recipe} />
      <section aria-labelledby={`recipe-${recipe.id}-rules`} className="flex min-w-0 flex-col gap-3">
        <h2 id={`recipe-${recipe.id}-rules`} className={LABEL}>
          In production
        </h2>
        <ul className="flex flex-col gap-2">
          {recipe.notes.map((note) => (
            <li key={note} className="flex gap-2 text-sm leading-relaxed">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent-text" aria-hidden="true" />
              <span>{note}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
