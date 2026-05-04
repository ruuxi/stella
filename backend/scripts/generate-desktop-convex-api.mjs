import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const backendRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(backendRoot, "..");
const configPath = path.join(backendRoot, "convex", "tsconfig.json");
const apiPath = path.join(backendRoot, "convex", "_generated", "api.d.ts");
const outputPath = path.join(repoRoot, "runtime", "contracts", "convex-api.ts");

const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
  throw new Error(
    ts.formatDiagnosticsWithColorAndContext([configFile.error], formatHost()),
  );
}

const parsedConfig = ts.parseJsonConfigFileContent(
  configFile.config,
  ts.sys,
  path.dirname(configPath),
);

const compilerOptions = {
  ...parsedConfig.options,
  noEmit: true,
  noUnusedLocals: false,
  noUnusedParameters: false,
  verbatimModuleSyntax: false,
};

const program = ts.createProgram(parsedConfig.fileNames, compilerOptions);
const checker = program.getTypeChecker();
const apiSource = program.getSourceFile(apiPath);

if (!apiSource) {
  throw new Error(`Missing Convex generated API file at ${apiPath}`);
}

const apiModule = checker.getSymbolAtLocation(apiSource);
const apiSymbol = apiModule
  ? checker
      .getExportsOfModule(apiModule)
      .find((symbol) => symbol.name === "api")
  : undefined;

if (!apiSymbol) {
  throw new Error(
    "Could not find exported `api` symbol in Convex generated API.",
  );
}

const apiType = checker.getTypeOfSymbolAtLocation(apiSymbol, apiSource);
const functionReferenceNames = new Set();

function renderApiObject(type, depth = 0) {
  const lines = ["{"];
  for (const property of checker.getPropertiesOfType(type)) {
    const propertyType = checker.getTypeOfSymbolAtLocation(property, apiSource);
    const rendered = renderType(propertyType, depth + 1);
    lines.push(
      `${indent(depth + 1)}${JSON.stringify(property.name)}: ${rendered};`,
    );
  }
  lines.push(`${indent(depth)}}`);
  return lines.join("\n");
}

function renderType(type, depth) {
  const typeText = checker.typeToString(
    type,
    apiSource,
    ts.TypeFormatFlags.NoTruncation |
      ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType |
      ts.TypeFormatFlags.UseTypeOfFunction,
  );

  if (typeText.startsWith("FunctionReference<")) {
    functionReferenceNames.add("FunctionReference");
    const callType = propertyTypeText(type, "_type");
    const visibilityType = propertyTypeText(type, "_visibility");
    const argsType = sanitizeType(propertyTypeText(type, "_args"));
    const componentPathType = sanitizeType(
      propertyTypeText(type, "_componentPath"),
    );
    return `FunctionReference<${callType}, ${visibilityType}, ${argsType}, any, ${componentPathType}>`;
  }

  return renderApiObject(type, depth);
}

function propertyTypeText(type, propertyName) {
  const property = checker
    .getPropertiesOfType(type)
    .find((symbol) => symbol.name === propertyName);
  if (!property) {
    throw new Error(`FunctionReference is missing ${propertyName}`);
  }
  return checker.typeToString(
    checker.getTypeOfSymbolAtLocation(property, apiSource),
    apiSource,
    ts.TypeFormatFlags.NoTruncation |
      ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType |
      ts.TypeFormatFlags.UseTypeOfFunction,
  );
}

function sanitizeType(typeText) {
  return typeText
    .replace(
      new RegExp(
        'import\\("[^"]*/convex/dist/esm-types/values/value"\\)\\.Id<',
        "g",
      ),
      "Id<",
    )
    .replace(
      new RegExp(
        'import\\("[^"]*/backend/convex/_generated/dataModel"\\)\\.Id',
        "g",
      ),
      "Id",
    )
    .replace(
      new RegExp(
        'import\\("[^"]*/convex/dist/esm-types/values/value"\\)\\.Value',
        "g",
      ),
      "Value",
    )
    .replace(
      new RegExp(
        'import\\("[^"]*/convex/dist/esm-types/server/pagination"\\)\\.Cursor',
        "g",
      ),
      "string",
    )
    .replace(/\b[a-z][A-Za-z0-9_]*\.[A-Za-z0-9_]+/g, "unknown");
}

function indent(depth) {
  return "  ".repeat(depth);
}

function formatHost() {
  return {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => "\n",
  };
}

const body = renderApiObject(apiType);
const imports = [
  `import { anyApi } from "convex/server";`,
  `import type { ${[...functionReferenceNames].sort().join(", ")} } from "convex/server";`,
  `import type { Value } from "convex/values";`,
];

const source = `${imports.join("\n")}

type Id<_TableName extends string> = string;

export const api: PublicApiType = anyApi as unknown as PublicApiType;

export type PublicApiType = ${body} & Record<string, any>;
`;

fs.writeFileSync(outputPath, source, "utf8");
console.log(`Wrote ${path.relative(repoRoot, outputPath)}`);
