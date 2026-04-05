import { CompiledScript } from "./compiled-script.js";
import { attachBytecode } from "./bytecode.js";
import { compileProgram } from "./compiler.js";
import { JSLiteRuntimeError, JSLiteSyntaxError } from "./errors.js";
import { Interpreter } from "./interpreter.js";
import { Parser } from "./parser.js";
import { HostObjectProxy } from "./runtime.js";

export class Engine {
  constructor() {
    this.outputLines = [];
    this.compileCache = new Map();
    this.interpreter = new Interpreter(this.outputLines);
  }

  compile(source) {
    const normalizedSource = String(source);
    const cached = this.compileCache.get(normalizedSource);

    if (cached) {
      return cached;
    }

    try {
      const program = attachBytecode(compileProgram(new Parser(normalizedSource).parse()));
      const compiled = new CompiledScript(normalizedSource, program);
      this.compileCache.set(normalizedSource, compiled);
      return compiled;
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  run(program, globals = {}) {
    this.outputLines = [];

    if (!(program instanceof CompiledScript)) {
      throw new TypeError("Unsupported compiled program");
    }

    return this.executeProgram(program.program, globals);
  }

  eval(source, globals = {}) {
    const compiled = this.compile(source);
    return this.run(compiled, globals);
  }

  getOutput() {
    return this.outputLines.join("");
  }

  getOutputLines() {
    return [...this.outputLines];
  }

  executeProgram(program, globals) {
    this.interpreter.outputLines = this.outputLines;

    try {
      return normalizeUndefined(this.interpreter.execute(program, globals));
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  normalizeError(error) {
    if (error instanceof JSLiteRuntimeError || error instanceof JSLiteSyntaxError) {
      return error;
    }

    if (error && error.name === "SyntaxError") {
      return new JSLiteSyntaxError(error.message);
    }

    return new JSLiteRuntimeError(error?.message || String(error));
  }
}

function normalizeUndefined(value) {
  if (value === undefined) {
    return null;
  }

  if (value instanceof HostObjectProxy) {
    return value.target;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeUndefined(entry));
  }

  if (value && typeof value === "object") {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = normalizeUndefined(entry);
    }
    return result;
  }

  return value;
}
