#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { Engine } from "../src/index.js";

function readInput(args) {
  const exprIndex = args.indexOf("-e");
  if (exprIndex !== -1) {
    const source = args[exprIndex + 1];
    if (source === undefined) {
      throw new Error("Missing source after -e");
    }
    return source;
  }

  const fileArg = args.find((arg) => !arg.startsWith("-"));
  if (!fileArg) {
    throw new Error("Usage: jslite [-e \"source\"] [--globals '{\"x\":1}'] [file]");
  }

  return fs.readFileSync(path.resolve(process.cwd(), fileArg), "utf8");
}

function readGlobals(args) {
  const globalsIndex = args.indexOf("--globals");
  if (globalsIndex === -1) {
    return {};
  }

  const source = args[globalsIndex + 1];
  if (source === undefined) {
    throw new Error("Missing JSON after --globals");
  }

  return JSON.parse(source);
}

function printResult(result) {
  if (result === undefined) {
    return;
  }

  if (typeof result === "string") {
    process.stdout.write(`${result}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function main() {
  const args = process.argv.slice(2);
  const engine = new Engine();
  const source = readInput(args);
  const globals = readGlobals(args);
  const result = engine.eval(source, globals);

  for (const line of engine.getOutputLines()) {
    process.stderr.write(`${line}\n`);
  }

  printResult(result);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.name}: ${error.message}\n`);
  process.exitCode = 1;
}
