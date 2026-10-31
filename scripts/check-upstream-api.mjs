import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
export const REPORT_MARKER = "<!-- qurl-upstream-operation-drift -->";
const REPOSITORY = "layervai/qurl-typescript";
const ISSUE = 50;

export function operationsFromSpec(spec) {
  if (
    typeof spec?.openapi !== "string" ||
    !spec.openapi.startsWith("3.") ||
    !spec.paths ||
    Array.isArray(spec.paths)
  ) {
    throw new Error("Expected an OpenAPI 3 document with paths");
  }
  const operations = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    if (path.startsWith("x-")) continue;
    if (!path.startsWith("/") || !item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Invalid OpenAPI path item");
    }
    // A future referenced path item must be resolved, never silently omitted.
    if (item.$ref) throw new Error("Referenced path items require resolver support");
    for (const [verb, operation] of Object.entries(item)) {
      if (!VERBS.has(verb)) continue;
      if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
        throw new Error("Invalid OpenAPI operation");
      }
      operations.push(`${verb.toUpperCase()} ${path}`);
    }
  }
  if (!operations.length) throw new Error("OpenAPI document contains no operations");
  return operations.sort();
}

export function renderReport(current, baseline) {
  if (
    !Array.isArray(baseline) ||
    baseline.some(
      (entry) =>
        typeof entry !== "string" ||
        !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE) \//.test(entry),
    ) ||
    JSON.stringify(baseline) !== JSON.stringify([...new Set(baseline)].sort())
  ) {
    throw new Error("Producer baseline must contain sorted, unique VERB /path entries");
  }
  const currentSet = new Set(current);
  const baselineSet = new Set(baseline);
  const added = current.filter((operation) => !baselineSet.has(operation));
  const removed = baseline.filter((operation) => !currentSet.has(operation));
  const detail =
    added.length || removed.length
      ? "```json\n" +
        JSON.stringify({ added, removed }, null, 2).replaceAll("`", "\\u0060") +
        "\n```"
      : "No operation drift.";
  return `${REPORT_MARKER}\n### Published API operation drift\n\nCompared [the published spec](https://layerv.ai/docs/qurls.yaml) with \`contract/upstream-operations.json\`.\nThis full producer baseline is separate from the SDK's hand-maintained endpoint subset.\n\n${detail}\n`;
}

function github(method, path, body) {
  const args = ["api", path];
  if (method === "GET") args.push("--paginate", "--slurp");
  else args.push("--method", method, "--input", "-");
  return JSON.parse(
    execFileSync("gh", args, {
      encoding: "utf8",
      input: body === undefined ? undefined : JSON.stringify(body),
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
}

export function publishReport(report, api = github) {
  if (!report.startsWith(REPORT_MARKER)) throw new Error("Invalid API drift report");
  const commentsPath = `repos/${REPOSITORY}/issues/${ISSUE}/comments`;
  const existing = api("GET", commentsPath + "?per_page=100")
    .flat()
    .findLast(
      (comment) =>
        comment.user?.login === "github-actions[bot]" && comment.body?.startsWith(REPORT_MARKER),
    );
  const normalize = (body) => body.replaceAll("\r\n", "\n").trimEnd();
  if (existing && normalize(existing.body) === normalize(report)) return "unchanged";
  // A new comment notifies subscribers even after the implementation issue closes.
  api("POST", commentsPath, { body: report });
  return existing ? "changed" : "created";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, input, ...extra] = process.argv.slice(2);
  if (!input || extra.length || !["snapshot", "check", "publish"].includes(mode)) {
    throw new Error("Usage: check-upstream-api.mjs snapshot|check|publish <input-file>");
  }
  if (mode === "publish") console.log(publishReport(readFileSync(input, "utf8")));
  else {
    const current = operationsFromSpec(parse(readFileSync(input, "utf8")));
    const output =
      mode === "snapshot"
        ? JSON.stringify(current, null, 2) + "\n"
        : renderReport(
            current,
            JSON.parse(
              readFileSync(new URL("../contract/upstream-operations.json", import.meta.url)),
            ),
          );
    process.stdout.write(output);
  }
}
