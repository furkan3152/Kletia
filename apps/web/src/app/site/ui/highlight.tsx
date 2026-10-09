import React from "react";

export type CodeLanguage = "ts" | "tsx" | "bash" | "json" | "http" | "html" | "text";

/**
 * Tiny, dependency-free highlighter for the snippets on the site. It never
 * produces HTML strings: tokens become React text nodes inside spans.
 */
const PATTERNS: Record<Exclude<CodeLanguage, "text">, RegExp> = {
  ts: /(?<comment>\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(?<string>"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(?<keyword>\b(?:import|from|export|const|let|var|await|async|function|return|new|if|else|for|of|in|type|interface|default|throw|try|catch|as)\b)|(?<literal>\b(?:true|false|null|undefined)\b)|(?<number>\b\d[\d_]*(?:\.\d+)?\b)|(?<tag><\/?[A-Z][A-Za-z0-9.]*|\/>)|(?<fn>\b[A-Za-z_$][\w$]*(?=\())/gu,
  tsx: /(?<comment>\/\/[^\n]*|\/\*[\s\S]*?\*\/|\{\/\*[\s\S]*?\*\/\})|(?<string>"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(?<keyword>\b(?:import|from|export|const|let|await|async|function|return|new|if|else|type|interface|default|as)\b)|(?<literal>\b(?:true|false|null|undefined)\b)|(?<number>\b\d[\d_]*(?:\.\d+)?\b)|(?<tag><\/?[A-Za-z][A-Za-z0-9.]*|\/?>)|(?<attr>\b[a-zA-Z-]+(?==))|(?<fn>\b[A-Za-z_$][\w$]*(?=\())/gu,
  bash: /(?<comment>(?:^|(?<=\s))#[^\n]*)|(?<string>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(?<keyword>\b(?:curl|npm|npx|pnpm|yarn|export|echo)\b)|(?<flag>(?<=\s)-{1,2}[A-Za-z][\w-]*)|(?<number>\b\d+\b)/gmu,
  json: /(?<key>"(?:\\.|[^"\\])*"(?=\s*:))|(?<string>"(?:\\.|[^"\\])*")|(?<literal>\b(?:true|false|null)\b)|(?<number>-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/gu,
  http: /(?<keyword>^(?:GET|POST|PUT|PATCH|DELETE)\b)|(?<key>^[A-Za-z-]+(?=:))|(?<string>"(?:\\.|[^"\\])*")|(?<number>\b\d+\b)/gmu,
  html: /(?<comment><!--[\s\S]*?-->)|(?<string>"[^"]*"|'[^']*')|(?<tag><\/?[A-Za-z][A-Za-z0-9-]*|\/?>)|(?<attr>\b[a-zA-Z-:]+(?==))/gu,
};

const TOKEN_CLASS: Record<string, string> = {
  comment: "text-[#8B97A8] italic",
  string: "text-[#5CF2B4]",
  keyword: "text-[#FFD60A]",
  literal: "text-[#FF9EC4]",
  number: "text-[#FF9EC4]",
  tag: "text-[#C4A1FF]",
  attr: "text-[#93B4FF]",
  fn: "text-[#93B4FF]",
  key: "text-[#93B4FF]",
  flag: "text-[#93B4FF]",
};

export function highlightCode(code: string, language: CodeLanguage): React.ReactNode[] {
  if (language === "text") return [code];
  const pattern = new RegExp(PATTERNS[language].source, PATTERNS[language].flags);
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let index = 0;
  for (const match of code.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (match[0].length === 0) continue;
    if (start > cursor) nodes.push(code.slice(cursor, start));
    const group = Object.entries(match.groups ?? {}).find(([, value]) => value !== undefined)?.[0];
    nodes.push(
      <span key={`t${index}`} className={group ? TOKEN_CLASS[group] : undefined}>
        {match[0]}
      </span>,
    );
    index += 1;
    cursor = start + match[0].length;
  }
  if (cursor < code.length) nodes.push(code.slice(cursor));
  return nodes;
}
