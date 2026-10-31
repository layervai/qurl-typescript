import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { parse } from "yaml";

// shortcut: selectors read current direct schema/header/query bounds; extend them if a published bound moves behind references or inheritance.
function sourceValue(spec, source) {
  let schema;
  if (source.parameterComponent)
    schema = spec.components?.parameters?.[source.parameterComponent]?.schema;
  else if (source.operation) {
    const operations = Object.entries(spec.paths ?? {}).flatMap(([path, item]) =>
      path.startsWith("/")
        ? Object.entries(item ?? {})
            .filter(([method]) => /^(get|post|put|patch|delete|head|options|trace)$/.test(method))
            .map(([, operation]) => operation)
        : [],
    );
    const matches = operations.filter((operation) => operation?.operationId === source.operation);
    if (matches.length === 1) {
      const location = source.parameterIn ?? "header";
      const parameters = matches[0].parameters?.filter(
        (parameter) =>
          parameter.in === location &&
          typeof parameter.name === "string" &&
          (location === "header"
            ? parameter.name.toLowerCase() === source.parameter.toLowerCase()
            : parameter.name === source.parameter),
      );
      if (parameters?.length === 1) schema = parameters[0].schema;
    }
  } else {
    schema = spec.components?.schemas?.[source.schema];
    if (source.property) schema = schema?.properties?.[source.property];
    if (source.items) schema = schema?.items;
  }
  return schema?.[source.keyword];
}

export function validationBoundFindings(code, manifest, spec) {
  // Inspect literals without importing or executing the runtime client.
  const source = ts.createSourceFile("client-limits.ts", code, ts.ScriptTarget.Latest, true);
  const { diagnostics } = ts.transpileModule(code, {
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
  });
  if (diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
    throw new Error("Cannot parse SDK validation source");
  }
  const definitions = new Map();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text.startsWith("MAX_")) {
        if (definitions.has(declaration.name.text))
          throw new Error(`Duplicate SDK bound: ${declaration.name.text}`);
        definitions.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  const findings = [];
  const classified = [...Object.keys(manifest.bounds), ...Object.keys(manifest.local)];
  if (new Set(classified).size !== classified.length)
    throw new Error("Duplicate bound classification");
  for (const name of definitions.keys()) {
    if (!classified.includes(name))
      findings.push({ constant: name, problem: "Unclassified SDK bound" });
  }
  for (const name of classified) {
    if (!definitions.has(name))
      findings.push({ constant: name, problem: "Stale bound classification" });
  }
  for (const [name, reason] of Object.entries(manifest.local)) {
    if (typeof reason !== "string" || !reason.trim())
      throw new Error(`Missing safety-budget reason: ${name}`);
  }
  for (const [name, bound] of Object.entries(manifest.bounds)) {
    if (!Number.isSafeInteger(bound.expected) || bound.expected < 0 || !bound.sources?.length)
      throw new Error(`Invalid bound contract: ${name}`);
    const expression = definitions.get(name);
    if (definitions.has(name)) {
      const value =
        expression && (ts.isNumericLiteral(expression) || ts.isBigIntLiteral(expression))
          ? Number(expression.text.replaceAll("_", "").replace(/n$/, ""))
          : (expression?.getText(source) ?? null);
      if (value !== bound.expected)
        findings.push({ constant: name, expected: bound.expected, actual: value });
    }
    if (spec) {
      for (const rule of bound.sources) {
        const { expected = bound.expected, ...location } = rule;
        const actual = sourceValue(spec, rule);
        if (actual !== expected)
          findings.push({ constant: name, source: location, expected, actual: actual ?? null });
      }
    }
  }
  return findings;
}

export function readClientValidationSource(directory = new URL("../src/", import.meta.url)) {
  return readdirSync(directory)
    .filter(
      (name) =>
        name.startsWith("client") && name.endsWith(".ts") && !/\.(?:test|spec|d)\.ts$/.test(name),
    )
    .sort()
    .map((name) => readFileSync(new URL(name, directory), "utf8"))
    .join("\n");
}

export function checkValidationBounds(spec) {
  return validationBoundFindings(
    readClientValidationSource(),
    JSON.parse(readFileSync(new URL("../contract/validation-bounds.json", import.meta.url))),
    spec,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3)
    throw new Error("Usage: check-validation-bounds.mjs <published-spec>");
  const findings = checkValidationBounds(
    parse(readFileSync(process.argv[2], "utf8"), { merge: true }),
  );
  if (findings.length) {
    console.error(JSON.stringify(findings, null, 2));
    process.exitCode = 1;
  } else console.log("SDK validation bounds match the published contract");
}
