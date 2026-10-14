/**
 * Project settings and publishable keys (integrator design 4.8, phase 2):
 * `kletia project get|set|verify-domain` and `kletia keys create-publishable`.
 * Reads need a key of the project; writes need a project key with its
 * current secret.
 */
import type { ProjectView } from "@kletia/core";
import type { ProjectSettingsPatch } from "@kletia/sdk";
import { stringOption, UsageError } from "./args.js";
import { EXIT_OK, signalOption, type Command } from "./common.js";
import { readJson } from "./contracts.js";
import { abandonSecretSink, deliverSecret, openSecretSink, SECRET_OPTIONS } from "./secrets.js";
import { when, type Printer } from "./output.js";

function printProject(print: Printer, project: ProjectView): void {
  const settings = project.settings;
  print.out(`${project.id}  version ${project.version}  hash ${project.hash}`);
  print.out(`updated ${when(project.updatedAt)} by ${project.updatedBy}`);
  print.out(`brand: ${settings.brand ? `${settings.brand.name}${settings.brand.website ? ` (${settings.brand.website})` : ""}` : "-"}`);
  print.out(`domain: ${project.domain.host ?? "-"}  ${project.domain.verified ? "verified" : "not verified"}${project.domain.checkedAt ? `  checked ${when(project.domain.checkedAt)}` : ""}`);
  if (!project.domain.verified && project.domain.host) print.out(`  publish at https://${project.domain.host}/.well-known/kletia.json: ${project.domain.file}`);
  print.out(`allowed origins: ${settings.allowedOrigins && settings.allowedOrigins.length > 0 ? settings.allowedOrigins.join(", ") : "-"}`);
  const defaults = settings.defaults;
  if (defaults) {
    print.out(
      `defaults: lane ${defaults.lane ?? "-"}  networks ${defaults.networks?.join(",") ?? "any"}  start ${defaults.sourceNetwork ?? "-"}  actions ${defaults.actions?.join(",") ?? "any"}`,
    );
  }
  for (const flow of settings.flows ?? []) print.out(`flow ${flow.id}: ${flow.label} (${flow.actions.length} action${flow.actions.length === 1 ? "" : "s"}, saved by ${flow.ownerKeyId})`);
}

const projectGet: Command = {
  name: "project get",
  summary: "Your project's settings, version, hash (for --if-match) and domain proof.",
  key: true,
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const project = await context.client().projects.get(signalOption(context));
    if (context.json) context.print.json(project);
    else printProject(context.print, project);
    return EXIT_OK;
  },
};

const projectSet: Command = {
  name: "project set",
  summary: "Merge-patch the project settings from a JSON file (null removes a field); refused if the project changed since --if-match.",
  args: "--file <patch.json> [--if-match <hash>]",
  key: true,
  options: {
    file: { type: "string", value: "<path>", description: "JSON merge patch of kletia.project/v1 settings (`-` reads stdin)." },
    "if-match": { type: "string", value: "<hash>", description: "The hash the change is based on (default: the current one, read first)." },
  },
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const patch = await readJson(context, stringOption(context.values, "file"));
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new UsageError("The patch must be a JSON object of project settings.", context.usage);
    let ifMatch = stringOption(context.values, "if-match");
    if (ifMatch !== undefined && !/^(?:sha256:)?[0-9a-f]{64}$/u.test(ifMatch)) throw new UsageError("--if-match takes the project hash from `kletia project get`.", context.usage);
    // Without --if-match the change is based on what is stored now; a concurrent change still answers PROJECT_CONFLICT.
    ifMatch ??= (await context.client().projects.get(signalOption(context))).hash;
    const project = await context.client().projects.update(patch as ProjectSettingsPatch, { ifMatch, ...signalOption(context) });
    if (context.json) context.print.json(project);
    else {
      printProject(context.print, project);
      context.print.err(`Saved version ${project.version}.`);
    }
    return EXIT_OK;
  },
};

const projectVerifyDomain: Command = {
  name: "project verify-domain",
  summary: "Check https://<website>/.well-known/kletia.json now (it must list this project).",
  key: true,
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const project = await context.client().projects.verifyDomain(signalOption(context));
    if (context.json) context.print.json(project);
    else {
      printProject(context.print, project);
      context.print.err(project.domain.verified ? "The domain is verified." : "The domain is not verified yet.");
    }
    return EXIT_OK;
  },
};

const keysCreatePublishable: Command = {
  name: "keys create-publishable",
  summary: "Issue a publishable key (kl_pub_…) for browsers: it works only from the project's allowed origins and under its defaults.",
  args: "[--label <label>]",
  key: true,
  options: {
    label: { type: "string", value: "<label>", description: "What it is for, e.g. website (default: website)." },
    ...SECRET_OPTIONS,
  },
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const label = stringOption(context.values, "label") ?? "website";
    if (!label.trim() || label.length > 80) throw new UsageError("--label is 1-80 characters.", context.usage);
    const sink = await openSecretSink(context);
    let issued;
    try {
      issued = await context.client().projects.createPublishableKey({ label }, signalOption(context));
    } catch (error) {
      await abandonSecretSink(sink);
      throw error;
    }
    const { key, ...record } = issued;
    await deliverSecret(context, sink, key, record, "key", `Created ${record.id} (${record.label}). Publishable keys are meant for browser code; they are shown once.`);
    return EXIT_OK;
  },
};

export const PROJECT_COMMANDS: readonly Command[] = Object.freeze([projectGet, projectSet, projectVerifyDomain, keysCreatePublishable]);
