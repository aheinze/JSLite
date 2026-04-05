import { JSLiteRuntimeError } from "./errors.js";

export const BUILTIN_GLOBAL_NAMES = [
  "console",
  "console_log",
  "Math",
  "JSON",
  "Array",
  "Object",
  "Number",
  "String",
  "Date",
  "RegExp",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURIComponent",
  "decodeURIComponent",
  "encodeURI",
  "decodeURI",
  "NaN",
  "Infinity",
  "undefined",
];

const FORBIDDEN_PROPERTIES = new Set([
  "__proto__",
  "constructor",
  "caller",
  "callee",
  "arguments",
]);

const SEALED_OBJECTS = new WeakSet();

export class NativeFunction {
  constructor(name, implementation, options = {}) {
    this.name = name || "anonymous";
    this.implementation = implementation;
    this.constructImplementation = options.constructImplementation ?? null;
    this.properties = createDictionary();

    if (options.hasPrototype) {
      this.properties.prototype = createDictionary();
    }

    for (const [key, value] of Object.entries(options.properties ?? {})) {
      this.properties[key] = value;
    }
  }

  callFromInterpreter(interpreter, args, thisValue) {
    return this.implementation({
      interpreter,
      args,
      thisValue,
    });
  }

  constructFromInterpreter(interpreter, args) {
    if (typeof this.constructImplementation !== "function") {
      throw new JSLiteRuntimeError("Value is not a constructor");
    }

    return this.constructImplementation({
      interpreter,
      args,
    });
  }
}

export class HostObjectProxy {
  constructor(target) {
    this.target = target;
    this.methodCache = createDictionary();
  }
}

class JSLiteDate {
  constructor(timestamp) {
    this.timestamp = Number(timestamp);
  }
}

export class JSLiteRegExp {
  constructor(pattern, flags = "") {
    this.pattern = String(pattern);
    this.flags = String(flags);
    this.lastIndex = 0;
  }

  toNative() {
    return new RegExp(this.pattern, this.flags);
  }
}

export function createDictionary(prototype = null) {
  return Object.create(prototype);
}

const ARRAY_METHOD_CACHE = createDictionary();
const STRING_METHOD_CACHE = createDictionary();
const NUMBER_METHOD_CACHE = createDictionary();
const DATE_METHOD_CACHE = createDictionary();
const REGEX_METHOD_CACHE = createDictionary();

const OBJECT_HAS_OWN_PROPERTY = new NativeFunction("Object.hasOwnProperty", ({ args, thisValue }) =>
  Object.prototype.hasOwnProperty.call(thisValue, normalizePropertyKey(args[0]))
);

let sharedBuiltinsCache = null;

function isPlainObject(value) {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isObjectLike(value) {
  return value !== null && (
    typeof value === "object" ||
    value instanceof NativeFunction ||
    value instanceof HostObjectProxy ||
    isUserFunction(value)
  );
}

function sealObject(object) {
  SEALED_OBJECTS.add(object);
  return object;
}

function sealBuiltinGraph(value, seen = new WeakSet()) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return;
  }

  if (seen.has(value)) {
    return;
  }

  seen.add(value);
  sealObject(value);

  if (value instanceof NativeFunction && value.properties) {
    sealBuiltinGraph(value.properties, seen);
  }

  for (const key of Object.keys(value)) {
    sealBuiltinGraph(value[key], seen);
  }
}

function normalizePropertyKey(property) {
  if (typeof property === "number") {
    if (Number.isNaN(property)) {
      return "NaN";
    }
    return String(property);
  }

  if (typeof property === "boolean" || property === null) {
    return String(property);
  }

  if (property === undefined) {
    return "undefined";
  }

  return String(property);
}

function isArrayIndexKey(key) {
  return /^(0|[1-9][0-9]*)$/.test(key);
}

function charsOf(value) {
  return Array.from(String(value));
}

function stringLength(value) {
  return charsOf(value).length;
}

function charAtCodePoint(value, index) {
  const chars = charsOf(value);
  const resolved = toRelativeIndex(index, chars.length);
  return resolved >= 0 && resolved < chars.length ? chars[resolved] : undefined;
}

function charAtPosition(value, index) {
  const chars = charsOf(value);
  const resolved = Math.trunc(Number(index) || 0);
  return resolved >= 0 && resolved < chars.length ? chars[resolved] : undefined;
}

function sliceCodePoints(value, start = 0, end = undefined) {
  const chars = charsOf(value);
  const resolvedStart = normalizeSliceIndex(start, chars.length);
  const resolvedEnd = end === undefined ? chars.length : normalizeSliceIndex(end, chars.length);
  return chars.slice(resolvedStart, resolvedEnd).join("");
}

function substringCodePoints(value, start = 0, end = undefined) {
  const chars = charsOf(value);
  let from = Math.max(0, Number(start) || 0);
  let to = end === undefined ? chars.length : Math.max(0, Number(end) || 0);
  from = Math.min(from, chars.length);
  to = Math.min(to, chars.length);
  if (from > to) {
    [from, to] = [to, from];
  }
  return chars.slice(from, to).join("");
}

function indexOfCodePoints(haystack, needle, fromIndex = 0, reverse = false) {
  const source = charsOf(haystack);
  const search = charsOf(needle);

  if (search.length === 0) {
    return clampIndex(Number(fromIndex) || 0, source.length);
  }

  if (reverse) {
    let start = fromIndex === undefined
      ? source.length - search.length
      : Math.min(source.length - search.length, Number(fromIndex) || 0);
    start = Math.max(0, start);

    for (let index = start; index >= 0; index -= 1) {
      if (matchesAt(source, search, index)) {
        return index;
      }
    }

    return -1;
  }

  const start = clampIndex(Number(fromIndex) || 0, source.length);
  for (let index = start; index <= source.length - search.length; index += 1) {
    if (matchesAt(source, search, index)) {
      return index;
    }
  }

  return -1;
}

function matchesAt(source, search, index) {
  for (let offset = 0; offset < search.length; offset += 1) {
    if (source[index + offset] !== search[offset]) {
      return false;
    }
  }
  return true;
}

function clampIndex(value, length) {
  if (!Number.isFinite(value)) {
    return value < 0 ? 0 : length;
  }
  return Math.max(0, Math.min(length, Math.trunc(value)));
}

function normalizeSliceIndex(value, length) {
  const numeric = Number(value) || 0;
  if (numeric < 0) {
    return Math.max(0, length + Math.trunc(numeric));
  }
  return Math.min(length, Math.trunc(numeric));
}

function toRelativeIndex(value, length) {
  const numeric = Number(value) || 0;
  if (numeric < 0) {
    return length + Math.trunc(numeric);
  }
  return Math.trunc(numeric);
}

export function fromHostValue(value) {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (
    value instanceof NativeFunction ||
    value instanceof HostObjectProxy ||
    value instanceof JSLiteDate ||
    value instanceof JSLiteRegExp
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => fromHostValue(entry));
  }

  if (typeof value === "function") {
    return createHostFunction(value.name || "host", value);
  }

  if (value instanceof Date) {
    return new JSLiteDate(value.getTime());
  }

  if (value instanceof RegExp) {
    return new JSLiteRegExp(value.source, value.flags);
  }

  if (isPlainObject(value)) {
    const result = createDictionary();
    for (const [key, entry] of Object.entries(value)) {
      result[key] = fromHostValue(entry);
    }
    return result;
  }

  if (typeof value === "object") {
    return new HostObjectProxy(value);
  }

  throw new JSLiteRuntimeError(
    `Unsupported host value '${Object.prototype.toString.call(value)}'`
  );
}

export function toHostValue(value) {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => toHostValue(entry));
  }

  if (value instanceof HostObjectProxy) {
    return value.target;
  }

  if (value instanceof JSLiteDate) {
    return new Date(value.timestamp);
  }

  if (value instanceof JSLiteRegExp) {
    return value.toNative();
  }

  if (value instanceof NativeFunction || isUserFunction(value)) {
    return value;
  }

  if (typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value)) {
      result[key] = toHostValue(value[key]);
    }
    return result;
  }

  return value;
}

export function isTruthy(value) {
  if (value === undefined || value === null) {
    return false;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0 && !Number.isNaN(value);
  }

  if (typeof value === "string") {
    return value.length > 0;
  }

  return true;
}

export function typeOf(value) {
  if (value === undefined) {
    return "undefined";
  }

  if (value === null) {
    return "object";
  }

  if (value instanceof NativeFunction || isUserFunction(value)) {
    return "function";
  }

  if (
    value instanceof HostObjectProxy ||
    value instanceof JSLiteDate ||
    value instanceof JSLiteRegExp ||
    Array.isArray(value)
  ) {
    return "object";
  }

  return typeof value;
}

export function isNullish(value) {
  return value === undefined || value === null;
}

export function toJsNumber(value) {
  if (typeof value === "number") {
    return value;
  }

  if (value === undefined) {
    return Number.NaN;
  }

  if (value === null) {
    return 0;
  }

  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  if (typeof value === "string") {
    return Number(value);
  }

  if (Array.isArray(value)) {
    return Number(toJsString(value));
  }

  if (value instanceof HostObjectProxy) {
    return Number(value.target);
  }

  if (value instanceof JSLiteDate) {
    return value.timestamp;
  }

  if (value instanceof JSLiteRegExp) {
    return Number.NaN;
  }

  return Number.NaN;
}

function isNumericLikeString(value) {
  return typeof value === "string" && !Number.isNaN(Number(value));
}

export function compareRelationalValues(left, right, operator) {
  const useNumericStringComparison = isNumericLikeString(left) && isNumericLikeString(right);
  const leftValue = useNumericStringComparison ? Number(left) : left;
  const rightValue = useNumericStringComparison ? Number(right) : right;

  switch (operator) {
    case "<":
      return leftValue < rightValue;
    case "<=":
      return leftValue <= rightValue;
    case ">":
      return leftValue > rightValue;
    case ">=":
      return leftValue >= rightValue;
    default:
      throw new JSLiteRuntimeError(`Unsupported relational operator '${operator}'`);
  }
}

export function toJsString(value) {
  if (value === undefined) {
    return "undefined";
  }

  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      return "NaN";
    }
    if (value === Number.POSITIVE_INFINITY) {
      return "Infinity";
    }
    if (value === Number.NEGATIVE_INFINITY) {
      return "-Infinity";
    }
    return String(value);
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (Array.isArray(value)) {
    return value.map((entry) => isNullish(entry) ? "" : toJsString(entry)).join(",");
  }

  if (value instanceof JSLiteDate) {
    return dateToString(value.timestamp);
  }

  if (value instanceof JSLiteRegExp) {
    return `/${value.pattern}/${value.flags}`;
  }

  if (value instanceof NativeFunction || isUserFunction(value)) {
    return `function ${value.name || "anonymous"}() { [native code] }`;
  }

  if (value instanceof HostObjectProxy) {
    return String(value.target);
  }

  return "[object Object]";
}

export function safeGet(target, property) {
  if (target === null || target === undefined) {
    throw new JSLiteRuntimeError("TypeError: Cannot read properties of null or undefined");
  }

  const key = normalizePropertyKey(property);
  if (FORBIDDEN_PROPERTIES.has(key)) {
    return undefined;
  }

  if (Array.isArray(target)) {
    return getArrayMember(target, key);
  }

  if (typeof target === "string") {
    return getStringMember(target, key);
  }

  if (typeof target === "number") {
    return getNumberMember(target, key);
  }

  if (target instanceof JSLiteDate) {
    return getDateMember(target, key);
  }

  if (target instanceof JSLiteRegExp) {
    return getRegexMember(target, key);
  }

  if (target instanceof HostObjectProxy) {
    return getHostObjectMember(target, key);
  }

  if (target instanceof NativeFunction || isUserFunction(target)) {
    return Object.prototype.hasOwnProperty.call(target.properties, key)
      ? target.properties[key]
      : undefined;
  }

  if (typeof target !== "object") {
    return undefined;
  }

  if (key === "hasOwnProperty") {
    return OBJECT_HAS_OWN_PROPERTY;
  }

  let current = target;
  while (current) {
    if (Object.prototype.hasOwnProperty.call(current, key)) {
      return current[key];
    }
    current = Object.getPrototypeOf(current);
  }

  return undefined;
}

export function safeSet(target, property, value) {
  if (target === null || target === undefined) {
    throw new JSLiteRuntimeError("Cannot set properties of null or undefined");
  }

  const key = normalizePropertyKey(property);
  if (FORBIDDEN_PROPERTIES.has(key)) {
    throw new JSLiteRuntimeError(`Property '${key}' is blocked in the sandbox`);
  }

  if (SEALED_OBJECTS.has(target)) {
    throw new JSLiteRuntimeError("Cannot modify sealed builtin objects");
  }

  if (Array.isArray(target)) {
    if (key === "length") {
      target.length = Math.max(0, Math.trunc(toJsNumber(value)));
      return value;
    }
    if (isArrayIndexKey(key)) {
      target[Number(key)] = value;
      return value;
    }
    target[key] = value;
    return value;
  }

  if (typeof target === "string" || typeof target === "number" || typeof target === "boolean") {
    throw new JSLiteRuntimeError("Target does not support property assignment");
  }

  if (target instanceof HostObjectProxy) {
    delete target.methodCache[key];
    target.target[key] = toHostValue(value);
    return value;
  }

  if (target instanceof NativeFunction || isUserFunction(target)) {
    target.properties[key] = value;
    return value;
  }

  target[key] = value;
  return value;
}

export function deleteProperty(target, property) {
  if (target === null || target === undefined) {
    throw new JSLiteRuntimeError("Cannot delete properties of null or undefined");
  }

  const key = normalizePropertyKey(property);
  if (FORBIDDEN_PROPERTIES.has(key)) {
    return true;
  }

  if (SEALED_OBJECTS.has(target)) {
    return false;
  }

  if (Array.isArray(target)) {
    if (isArrayIndexKey(key)) {
      target[Number(key)] = undefined;
      return true;
    }
    delete target[key];
    return true;
  }

  if (typeof target === "string" || typeof target === "number" || typeof target === "boolean") {
    return true;
  }

  if (target instanceof HostObjectProxy) {
    delete target.methodCache[key];
    return delete target.target[key];
  }

  if (target instanceof NativeFunction || isUserFunction(target)) {
    delete target.properties[key];
    return true;
  }

  delete target[key];
  return true;
}

export function hasProperty(target, property) {
  if (target === null || target === undefined) {
    throw new JSLiteRuntimeError("Cannot use 'in' with null or undefined");
  }

  const key = normalizePropertyKey(property);

  if (Array.isArray(target)) {
    return isArrayIndexKey(key)
      ? Number(key) in target
      : key in target;
  }

  if (typeof target === "string") {
    return key === "length" || (isArrayIndexKey(key) && Number(key) < stringLength(target));
  }

  if (target instanceof HostObjectProxy) {
    return key in target.target;
  }

  if (target instanceof NativeFunction || isUserFunction(target)) {
    return key in target.properties;
  }

  if (typeof target !== "object") {
    return false;
  }

  return key in target;
}

export function instanceOfValue(value, ctor) {
  if (!isObjectLike(value)) {
    return false;
  }

  const prototype = safeGet(ctor, "prototype");
  const expected = prototype instanceof HostObjectProxy ? prototype.target : prototype;

  if (!expected || typeof expected !== "object") {
    return false;
  }

  let current = Object.getPrototypeOf(value instanceof HostObjectProxy ? value.target : value);
  while (current) {
    if (current === expected) {
      return true;
    }
    current = Object.getPrototypeOf(current);
  }

  return false;
}

export function callFunction(callee, args, thisValue, interpreter) {
  if (callee instanceof NativeFunction) {
    return callee.callFromInterpreter(interpreter, args, thisValue);
  }

  if (isUserFunction(callee)) {
    return callee.callFromInterpreter(interpreter, args, thisValue);
  }

  throw new JSLiteRuntimeError("Value is not callable");
}

export function constructValue(callee, args, interpreter) {
  if (callee instanceof NativeFunction) {
    return callee.constructFromInterpreter(interpreter, args);
  }

  if (isUserFunction(callee)) {
    return callee.constructFromInterpreter(interpreter, args);
  }

  throw new JSLiteRuntimeError("Value is not a constructor");
}

function describeValue(value) {
  return toJsString(value);
}

function createHostFunction(name, hostFunction, boundTarget = undefined) {
  const properties = createDictionary();
  if (hostFunction && typeof hostFunction.prototype === "object") {
    properties.prototype = new HostObjectProxy(hostFunction.prototype);
  } else {
    properties.prototype = createDictionary();
  }

  return new NativeFunction(name || hostFunction.name || "host", ({ args, thisValue }) => {
    const hostResult = hostFunction.apply(
      boundTarget ?? toHostValue(thisValue),
      args.map((arg) => toHostValue(arg))
    );
    return fromHostValue(hostResult);
  }, {
    constructImplementation: ({ args }) => fromHostValue(
      Reflect.construct(hostFunction, args.map((arg) => toHostValue(arg)))
    ),
    properties,
  });
}

function getHostObjectMember(proxy, key) {
  if (Object.prototype.hasOwnProperty.call(proxy.methodCache, key)) {
    return proxy.methodCache[key];
  }

  const value = proxy.target[key];
  if (typeof value === "function") {
    const wrapped = createHostFunction(
      `${proxy.target.constructor?.name || "host"}.${key}`,
      value,
      proxy.target
    );
    proxy.methodCache[key] = wrapped;
    return wrapped;
  }

  if (!(key in proxy.target)) {
    return undefined;
  }

  return fromHostValue(value);
}

export function createBuiltins(outputLines) {
  const consoleObject = sealObject(createDictionary());
  const consoleLog = sealObject(new NativeFunction("console.log", ({ args }) => {
    outputLines.push(`${args.map((arg) => describeValue(arg)).join(" ")}\n`);
    return undefined;
  }));
  consoleObject.log = consoleLog;

  return {
    console: consoleObject,
    console_log: consoleLog,
    ...getSharedBuiltins(),
  };
}

function getSharedBuiltins() {
  if (sharedBuiltinsCache === null) {
    sharedBuiltinsCache = createSharedBuiltins();
  }

  return sharedBuiltinsCache;
}

function createSharedBuiltins() {
  const mathObject = sealObject(createDictionary());
  for (const [name, value] of Object.entries({
    PI: Math.PI,
    E: Math.E,
    LN2: Math.LN2,
    LN10: Math.LN10,
    LOG2E: Math.LOG2E,
    LOG10E: Math.LOG10E,
    SQRT1_2: Math.SQRT1_2,
    SQRT2: Math.SQRT2,
  })) {
    mathObject[name] = value;
  }
  for (const name of [
    "abs",
    "ceil",
    "floor",
    "max",
    "min",
    "pow",
    "random",
    "round",
    "sqrt",
    "sin",
    "cos",
    "tan",
    "asin",
    "acos",
    "atan",
    "atan2",
    "log",
    "log2",
    "log10",
    "exp",
    "hypot",
    "sign",
    "trunc",
    "clz32",
  ]) {
    mathObject[name] = new NativeFunction(`Math.${name}`, ({ args }) => Math[name](...args.map((arg) => toJsNumber(arg))));
  }
  mathObject.cbrt = new NativeFunction("Math.cbrt", ({ args }) => Math.cbrt(toJsNumber(args[0])));

  const jsonObject = sealObject(createDictionary());
  jsonObject.stringify = new NativeFunction("JSON.stringify", ({ args }) => JSON.stringify(toHostValue(args[0])));
  jsonObject.parse = new NativeFunction("JSON.parse", ({ args }) => fromHostValue(JSON.parse(String(args[0]))));

  const arrayObject = sealObject(createDictionary());
  arrayObject.isArray = new NativeFunction("Array.isArray", ({ args }) => Array.isArray(args[0]));
  arrayObject.from = new NativeFunction("Array.from", ({ args }) => {
    const value = args[0];
    if (Array.isArray(value)) {
      return value.slice();
    }
    if (typeof value === "string") {
      return charsOf(value);
    }
    if (value && typeof value[Symbol.iterator] === "function") {
      return Array.from(value).map((entry) => fromHostValue(entry));
    }
    return [];
  });
  arrayObject.of = new NativeFunction("Array.of", ({ args }) => args.slice());

  const objectObject = sealObject(createDictionary());
  objectObject.keys = new NativeFunction("Object.keys", ({ args }) => Object.keys(args[0] ?? createDictionary()));
  objectObject.values = new NativeFunction("Object.values", ({ args }) => Object.values(args[0] ?? createDictionary()));
  objectObject.entries = new NativeFunction("Object.entries", ({ args }) =>
    Object.entries(args[0] ?? createDictionary()).map(([key, value]) => [key, value])
  );
  objectObject.assign = new NativeFunction("Object.assign", ({ args }) => {
    const target = args[0] ?? createDictionary();
    for (let index = 1; index < args.length; index += 1) {
      const source = args[index];
      if (!source || typeof source !== "object") {
        continue;
      }
      for (const key of Object.keys(source)) {
        target[key] = source[key];
      }
    }
    return target;
  });
  objectObject.is = new NativeFunction("Object.is", ({ args }) => Object.is(args[0], args[1]));
  objectObject.create = new NativeFunction("Object.create", ({ args }) => {
    const prototype = args[0] === null ? null : (args[0] && typeof args[0] === "object" ? args[0] : null);
    return createDictionary(prototype);
  });
  objectObject.freeze = new NativeFunction("Object.freeze", ({ args }) => args[0]);

  const numberCtor = new NativeFunction("Number", ({ args }) => toJsNumber(args[0]), {
    properties: {
      isInteger: new NativeFunction("Number.isInteger", ({ args }) => typeof args[0] === "number" && Number.isInteger(args[0])),
      isFinite: new NativeFunction("Number.isFinite", ({ args }) => typeof args[0] === "number" && Number.isFinite(args[0])),
      isNaN: new NativeFunction("Number.isNaN", ({ args }) => typeof args[0] === "number" && Number.isNaN(args[0])),
      parseInt: new NativeFunction("Number.parseInt", ({ args }) => Number.parseInt(String(args[0]), args[1] === undefined ? undefined : Math.trunc(toJsNumber(args[1])))),
      parseFloat: new NativeFunction("Number.parseFloat", ({ args }) => Number.parseFloat(String(args[0]))),
      MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
      MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER,
      EPSILON: Number.EPSILON,
      POSITIVE_INFINITY: Number.POSITIVE_INFINITY,
      NEGATIVE_INFINITY: Number.NEGATIVE_INFINITY,
      NaN: Number.NaN,
    },
  });

  const stringCtor = new NativeFunction("String", ({ args }) => toJsString(args[0] ?? ""), {
    properties: {
      fromCharCode: new NativeFunction("String.fromCharCode", ({ args }) =>
        String.fromCharCode(...args.map((arg) => Math.trunc(toJsNumber(arg))))
      ),
    },
  });

  const dateCtor = new NativeFunction("Date", () => dateToString(Date.now()), {
    constructImplementation: ({ args }) => constructDate(args),
    properties: {
      now: new NativeFunction("Date.now", () => Date.now()),
      parse: new NativeFunction("Date.parse", ({ args }) => Date.parse(String(args[0]))),
    },
  });

  const regexpCtor = new NativeFunction("RegExp", ({ args }) =>
    new JSLiteRegExp(args[0] ?? "", args[1] ?? ""), {
    constructImplementation: ({ args }) => new JSLiteRegExp(args[0] ?? "", args[1] ?? ""),
  });

  const sharedBuiltins = {
    Math: mathObject,
    JSON: jsonObject,
    Array: arrayObject,
    Object: objectObject,
    Number: numberCtor,
    String: stringCtor,
    Date: dateCtor,
    RegExp: regexpCtor,
    parseInt: new NativeFunction("parseInt", ({ args }) =>
      Number.parseInt(String(args[0]), args[1] === undefined ? undefined : Math.trunc(toJsNumber(args[1])))
    ),
    parseFloat: new NativeFunction("parseFloat", ({ args }) => Number.parseFloat(String(args[0]))),
    isNaN: new NativeFunction("isNaN", ({ args }) => Number.isNaN(toJsNumber(args[0]))),
    isFinite: new NativeFunction("isFinite", ({ args }) => Number.isFinite(toJsNumber(args[0]))),
    encodeURIComponent: new NativeFunction("encodeURIComponent", ({ args }) => encodeURIComponent(String(args[0] ?? ""))),
    decodeURIComponent: new NativeFunction("decodeURIComponent", ({ args }) => decodeURIComponent(String(args[0] ?? ""))),
    encodeURI: new NativeFunction("encodeURI", ({ args }) => encodeURI(String(args[0] ?? ""))),
    decodeURI: new NativeFunction("decodeURI", ({ args }) => decodeURI(String(args[0] ?? ""))),
    NaN: Number.NaN,
    Infinity: Number.POSITIVE_INFINITY,
    undefined,
  };

  sealBuiltinGraph(sharedBuiltins);
  return Object.freeze(sharedBuiltins);
}

function getArrayMember(target, key) {
  if (key === "length") {
    return target.length;
  }

  if (isArrayIndexKey(key)) {
    return target[Number(key)];
  }

  if (Object.prototype.hasOwnProperty.call(target, key)) {
    return target[key];
  }

  if (Object.prototype.hasOwnProperty.call(ARRAY_METHOD_CACHE, key)) {
    return ARRAY_METHOD_CACHE[key];
  }

  let member;
  switch (key) {
    case "push":
      member = new NativeFunction("Array.push", ({ args, thisValue }) => {
        ensureArrayReceiver(thisValue, "push");
        return thisValue.push(...args);
      });
      break;
    case "pop":
      member = new NativeFunction("Array.pop", ({ thisValue }) => {
        ensureArrayReceiver(thisValue, "pop");
        return thisValue.length === 0 ? undefined : thisValue.pop();
      });
      break;
    case "shift":
      member = new NativeFunction("Array.shift", ({ thisValue }) => {
        ensureArrayReceiver(thisValue, "shift");
        return thisValue.length === 0 ? undefined : thisValue.shift();
      });
      break;
    case "unshift":
      member = new NativeFunction("Array.unshift", ({ args, thisValue }) => {
        ensureArrayReceiver(thisValue, "unshift");
        return thisValue.unshift(...args);
      });
      break;
    case "join":
      member = new NativeFunction("Array.join", ({ args, thisValue }) => {
        ensureArrayReceiver(thisValue, "join");
        const separator = args[0] === undefined ? "," : String(args[0]);
        return thisValue.map((entry) => isNullish(entry) ? "" : toJsString(entry)).join(separator);
      });
      break;
    case "slice":
      member = new NativeFunction("Array.slice", ({ args, thisValue }) => {
        ensureArrayReceiver(thisValue, "slice");
        return thisValue.slice(
          normalizeSliceIndex(args[0] ?? 0, thisValue.length),
          args[1] === undefined ? undefined : normalizeSliceIndex(args[1], thisValue.length)
        );
      });
      break;
    case "concat":
      member = new NativeFunction("Array.concat", ({ args, thisValue }) => {
        ensureArrayReceiver(thisValue, "concat");
        const result = thisValue.slice();
        for (const arg of args) {
          if (Array.isArray(arg)) {
            result.push(...arg);
          } else {
            result.push(arg);
          }
        }
        return result;
      });
      break;
    case "indexOf":
      member = new NativeFunction("Array.indexOf", ({ args, thisValue }) => {
        ensureArrayReceiver(thisValue, "indexOf");
        const start = Math.max(0, Math.trunc(toJsNumber(args[1] ?? 0)));
        for (let index = start; index < thisValue.length; index += 1) {
          if (thisValue[index] === args[0]) {
            return index;
          }
        }
        return -1;
      });
      break;
    case "includes":
      member = new NativeFunction("Array.includes", ({ args, thisValue }) => {
        ensureArrayReceiver(thisValue, "includes");
        return thisValue.some((entry) => Object.is(entry, args[0]) || entry === args[0]);
      });
      break;
    case "at":
      member = new NativeFunction("Array.at", ({ args, thisValue }) => {
        ensureArrayReceiver(thisValue, "at");
        const index = toRelativeIndex(args[0] ?? 0, thisValue.length);
        return index >= 0 && index < thisValue.length ? thisValue[index] : undefined;
      });
      break;
    case "forEach":
      member = new NativeFunction("Array.forEach", ({ args, thisValue, interpreter }) => {
        ensureArrayReceiver(thisValue, "forEach");
        const callback = args[0];
        const thisArg = args[1];
        for (let index = 0; index < thisValue.length; index += 1) {
          callFunction(callback, [thisValue[index], index, thisValue], thisArg, interpreter);
        }
        return undefined;
      });
      break;
    case "map":
      member = new NativeFunction("Array.map", ({ args, thisValue, interpreter }) => {
        ensureArrayReceiver(thisValue, "map");
        const callback = args[0];
        const thisArg = args[1];
        const result = [];
        for (let index = 0; index < thisValue.length; index += 1) {
          result.push(callFunction(callback, [thisValue[index], index, thisValue], thisArg, interpreter));
        }
        return result;
      });
      break;
    case "filter":
      member = new NativeFunction("Array.filter", ({ args, thisValue, interpreter }) => {
        ensureArrayReceiver(thisValue, "filter");
        const callback = args[0];
        const thisArg = args[1];
        const result = [];
        for (let index = 0; index < thisValue.length; index += 1) {
          if (isTruthy(callFunction(callback, [thisValue[index], index, thisValue], thisArg, interpreter))) {
            result.push(thisValue[index]);
          }
        }
        return result;
      });
      break;
    case "find":
      member = new NativeFunction("Array.find", ({ args, thisValue, interpreter }) => {
        ensureArrayReceiver(thisValue, "find");
        const callback = args[0];
        const thisArg = args[1];
        for (let index = 0; index < thisValue.length; index += 1) {
          if (isTruthy(callFunction(callback, [thisValue[index], index, thisValue], thisArg, interpreter))) {
            return thisValue[index];
          }
        }
        return undefined;
      });
      break;
    case "findIndex":
      member = new NativeFunction("Array.findIndex", ({ args, thisValue, interpreter }) => {
        ensureArrayReceiver(thisValue, "findIndex");
        const callback = args[0];
        const thisArg = args[1];
        for (let index = 0; index < thisValue.length; index += 1) {
          if (isTruthy(callFunction(callback, [thisValue[index], index, thisValue], thisArg, interpreter))) {
            return index;
          }
        }
        return -1;
      });
      break;
    case "findLast":
      member = new NativeFunction("Array.findLast", ({ args, thisValue, interpreter }) => {
        ensureArrayReceiver(thisValue, "findLast");
        const callback = args[0];
        const thisArg = args[1];
        for (let index = thisValue.length - 1; index >= 0; index -= 1) {
          if (isTruthy(callFunction(callback, [thisValue[index], index, thisValue], thisArg, interpreter))) {
            return thisValue[index];
          }
        }
        return undefined;
      });
      break;
    case "findLastIndex":
      member = new NativeFunction("Array.findLastIndex", ({ args, thisValue, interpreter }) => {
        ensureArrayReceiver(thisValue, "findLastIndex");
        const callback = args[0];
        const thisArg = args[1];
        for (let index = thisValue.length - 1; index >= 0; index -= 1) {
          if (isTruthy(callFunction(callback, [thisValue[index], index, thisValue], thisArg, interpreter))) {
            return index;
          }
        }
        return -1;
      });
      break;
    case "reduce":
      member = new NativeFunction("Array.reduce", ({ args, thisValue, interpreter }) => {
        ensureArrayReceiver(thisValue, "reduce");
        return reduceArray(thisValue, args[0], args[1], interpreter, false);
      });
      break;
    case "reduceRight":
      member = new NativeFunction("Array.reduceRight", ({ args, thisValue, interpreter }) => {
        ensureArrayReceiver(thisValue, "reduceRight");
        return reduceArray(thisValue, args[0], args[1], interpreter, true);
      });
      break;
    case "every":
      member = new NativeFunction("Array.every", ({ args, thisValue, interpreter }) => {
        ensureArrayReceiver(thisValue, "every");
        const callback = args[0];
        const thisArg = args[1];
        for (let index = 0; index < thisValue.length; index += 1) {
          if (!isTruthy(callFunction(callback, [thisValue[index], index, thisValue], thisArg, interpreter))) {
            return false;
          }
        }
        return true;
      });
      break;
    case "some":
      member = new NativeFunction("Array.some", ({ args, thisValue, interpreter }) => {
        ensureArrayReceiver(thisValue, "some");
        const callback = args[0];
        const thisArg = args[1];
        for (let index = 0; index < thisValue.length; index += 1) {
          if (isTruthy(callFunction(callback, [thisValue[index], index, thisValue], thisArg, interpreter))) {
            return true;
          }
        }
        return false;
      });
      break;
    case "sort":
      member = new NativeFunction("Array.sort", ({ args, thisValue, interpreter }) => {
        ensureArrayReceiver(thisValue, "sort");
        const compare = args[0];
        if (compare === undefined || compare === null) {
          thisValue.sort((left, right) => toJsString(left).localeCompare(toJsString(right)));
        } else {
          thisValue.sort((left, right) => Math.trunc(toJsNumber(callFunction(compare, [left, right], undefined, interpreter))));
        }
        return thisValue;
      });
      break;
    case "splice":
      member = new NativeFunction("Array.splice", ({ args, thisValue }) => {
        ensureArrayReceiver(thisValue, "splice");
        const start = normalizeSliceIndex(args[0] ?? 0, thisValue.length);
        const deleteCount = args.length < 2 ? thisValue.length - start : Math.max(0, Math.trunc(toJsNumber(args[1])));
        return thisValue.splice(start, deleteCount, ...args.slice(2));
      });
      break;
    case "reverse":
      member = new NativeFunction("Array.reverse", ({ thisValue }) => {
        ensureArrayReceiver(thisValue, "reverse");
        thisValue.reverse();
        return thisValue;
      });
      break;
    case "flat":
      member = new NativeFunction("Array.flat", ({ args, thisValue }) => {
        ensureArrayReceiver(thisValue, "flat");
        return flattenArray(thisValue, Math.trunc(toJsNumber(args[0] ?? 1)));
      });
      break;
    case "flatMap":
      member = new NativeFunction("Array.flatMap", ({ args, thisValue, interpreter }) => {
        ensureArrayReceiver(thisValue, "flatMap");
        const callback = args[0];
        const thisArg = args[1];
        const mapped = [];
        for (let index = 0; index < thisValue.length; index += 1) {
          mapped.push(callFunction(callback, [thisValue[index], index, thisValue], thisArg, interpreter));
        }
        return flattenArray(mapped, 1);
      });
      break;
    case "fill":
      member = new NativeFunction("Array.fill", ({ args, thisValue }) => {
        ensureArrayReceiver(thisValue, "fill");
        const start = normalizeSliceIndex(args[1] ?? 0, thisValue.length);
        const end = args[2] === undefined ? thisValue.length : normalizeSliceIndex(args[2], thisValue.length);
        for (let index = start; index < end; index += 1) {
          thisValue[index] = args[0];
        }
        return thisValue;
      });
      break;
    default:
      return undefined;
  }

  ARRAY_METHOD_CACHE[key] = member;
  return member;
}

function getStringMember(target, key) {
  if (key === "length") {
    return stringLength(target);
  }

  if (isArrayIndexKey(key)) {
    return charAtCodePoint(target, Number(key));
  }

  if (Object.prototype.hasOwnProperty.call(STRING_METHOD_CACHE, key)) {
    return STRING_METHOD_CACHE[key];
  }

  let member;
  switch (key) {
    case "slice":
      member = new NativeFunction("String.slice", ({ args, thisValue }) =>
        sliceCodePoints(thisValue, args[0] ?? 0, args[1])
      );
      break;
    case "substring":
      member = new NativeFunction("String.substring", ({ args, thisValue }) =>
        substringCodePoints(thisValue, args[0] ?? 0, args[1])
      );
      break;
    case "split":
      member = new NativeFunction("String.split", ({ args, thisValue }) => {
        const source = String(thisValue);
        if (args[0] === undefined) {
          return [source];
        }
        const regexp = toRegExpValue(args[0]);
        if (regexp) {
          const result = source.split(regexp.toNative());
          return args[1] === undefined
            ? result
            : result.slice(0, Math.max(0, Math.trunc(toJsNumber(args[1]))));
        }
        if (args[0] === "") {
          const chars = charsOf(source);
          return args[1] === undefined ? chars : chars.slice(0, Math.max(0, Math.trunc(toJsNumber(args[1]))));
        }
        const result = source.split(String(args[0]));
        return args[1] === undefined ? result : result.slice(0, Math.max(0, Math.trunc(toJsNumber(args[1]))));
      });
      break;
    case "trim":
      member = new NativeFunction("String.trim", ({ thisValue }) => String(thisValue).trim());
      break;
    case "trimStart":
      member = new NativeFunction("String.trimStart", ({ thisValue }) => String(thisValue).trimStart());
      break;
    case "trimEnd":
      member = new NativeFunction("String.trimEnd", ({ thisValue }) => String(thisValue).trimEnd());
      break;
    case "toUpperCase":
      member = new NativeFunction("String.toUpperCase", ({ thisValue }) => String(thisValue).toUpperCase());
      break;
    case "toLowerCase":
      member = new NativeFunction("String.toLowerCase", ({ thisValue }) => String(thisValue).toLowerCase());
      break;
    case "includes":
      member = new NativeFunction("String.includes", ({ args, thisValue }) =>
        indexOfCodePoints(thisValue, args[0] ?? "", args[1] ?? 0) !== -1
      );
      break;
    case "charAt":
      member = new NativeFunction("String.charAt", ({ args, thisValue }) =>
        charAtPosition(thisValue, args[0] ?? 0) ?? ""
      );
      break;
    case "charCodeAt":
      member = new NativeFunction("String.charCodeAt", ({ args, thisValue }) => {
        const ch = charAtPosition(thisValue, args[0] ?? 0);
        return ch === undefined ? Number.NaN : ch.codePointAt(0);
      });
      break;
    case "indexOf":
      member = new NativeFunction("String.indexOf", ({ args, thisValue }) =>
        indexOfCodePoints(thisValue, args[0] ?? "", args[1] ?? 0)
      );
      break;
    case "lastIndexOf":
      member = new NativeFunction("String.lastIndexOf", ({ args, thisValue }) => {
        const search = String(args[0] ?? "");
        const fromIndex = args[1] === undefined ? undefined : Math.trunc(toJsNumber(args[1]));
        return String(thisValue).lastIndexOf(search, fromIndex);
      });
      break;
    case "startsWith":
      member = new NativeFunction("String.startsWith", ({ args, thisValue }) =>
        sliceCodePoints(thisValue, args[1] ?? 0, (Number(args[1] ?? 0) || 0) + stringLength(args[0] ?? ""))
          === String(args[0] ?? "")
      );
      break;
    case "endsWith":
      member = new NativeFunction("String.endsWith", ({ args, thisValue }) => {
        const value = String(thisValue);
        const chars = charsOf(value);
        const search = String(args[0] ?? "");
        const searchLength = stringLength(search);
        const endPosition = args[1] === undefined ? chars.length : clampIndex(args[1], chars.length);
        return chars.slice(Math.max(0, endPosition - searchLength), endPosition).join("") === search;
      });
      break;
    case "replace":
      member = new NativeFunction("String.replace", ({ args, thisValue, interpreter }) =>
        replaceString(thisValue, args[0], args[1], interpreter, false)
      );
      break;
    case "replaceAll":
      member = new NativeFunction("String.replaceAll", ({ args, thisValue, interpreter }) =>
        replaceString(thisValue, args[0], args[1], interpreter, true)
      );
      break;
    case "repeat":
      member = new NativeFunction("String.repeat", ({ args, thisValue }) =>
        String(thisValue).repeat(Math.max(0, Math.trunc(toJsNumber(args[0] ?? 0))))
      );
      break;
    case "padStart":
      member = new NativeFunction("String.padStart", ({ args, thisValue }) =>
        String(thisValue).padStart(Math.trunc(toJsNumber(args[0] ?? 0)), args[1] === undefined ? " " : String(args[1]))
      );
      break;
    case "padEnd":
      member = new NativeFunction("String.padEnd", ({ args, thisValue }) =>
        String(thisValue).padEnd(Math.trunc(toJsNumber(args[0] ?? 0)), args[1] === undefined ? " " : String(args[1]))
      );
      break;
    case "at":
      member = new NativeFunction("String.at", ({ args, thisValue }) => {
        const index = toRelativeIndex(args[0] ?? 0, stringLength(thisValue));
        return charAtCodePoint(thisValue, index);
      });
      break;
    case "concat":
      member = new NativeFunction("String.concat", ({ args, thisValue }) =>
        String(thisValue) + args.map((arg) => toJsString(arg)).join("")
      );
      break;
    case "match":
      member = new NativeFunction("String.match", ({ args, thisValue }) => {
        const regexp = toRegExpValue(args[0]);
        if (!regexp) {
          return undefined;
        }
        if (regexp.flags.includes("g")) {
          return String(thisValue).match(regexp.toNative());
        }
        return execMatch(regexp, String(thisValue), true);
      });
      break;
    case "matchAll":
      member = new NativeFunction("String.matchAll", ({ args, thisValue }) => {
        const regexp = toRegExpValue(args[0]);
        if (!regexp) {
          return [];
        }
        const global = regexp.flags.includes("g") ? regexp : new JSLiteRegExp(regexp.pattern, `${regexp.flags}g`);
        const matches = [];
        global.lastIndex = 0;
        while (true) {
          const match = execMatch(global, String(thisValue), false);
          if (match === null) {
            break;
          }
          matches.push(match);
          if (!global.flags.includes("g")) {
            break;
          }
        }
        return matches;
      });
      break;
    case "search":
      member = new NativeFunction("String.search", ({ args, thisValue }) => {
        const regexp = toRegExpValue(args[0]);
        if (!regexp) {
          return indexOfCodePoints(thisValue, String(args[0] ?? ""));
        }
        const native = regexp.toNative();
        const match = native.exec(String(thisValue));
        return match ? stringLength(String(thisValue).slice(0, match.index)) : -1;
      });
      break;
    default:
      return undefined;
  }

  STRING_METHOD_CACHE[key] = member;
  return member;
}

function getNumberMember(target, key) {
  if (Object.prototype.hasOwnProperty.call(NUMBER_METHOD_CACHE, key)) {
    return NUMBER_METHOD_CACHE[key];
  }

  let member;
  switch (key) {
    case "toFixed":
      member = new NativeFunction("Number.toFixed", ({ args, thisValue }) =>
        Number(thisValue).toFixed(Math.max(0, Math.trunc(toJsNumber(args[0] ?? 0))))
      );
      break;
    case "toPrecision":
      member = new NativeFunction("Number.toPrecision", ({ args, thisValue }) =>
        args[0] === undefined
          ? Number(thisValue).toString()
          : Number(thisValue).toPrecision(Math.max(1, Math.trunc(toJsNumber(args[0]))))
      );
      break;
    case "toExponential":
      member = new NativeFunction("Number.toExponential", ({ args, thisValue }) =>
        Number(thisValue).toExponential(Math.max(0, Math.trunc(toJsNumber(args[0] ?? 0))))
      );
      break;
    case "toString":
      member = new NativeFunction("Number.toString", ({ args, thisValue }) =>
        Number(thisValue).toString(args[0] === undefined ? undefined : Math.trunc(toJsNumber(args[0])))
      );
      break;
    default:
      return undefined;
  }

  NUMBER_METHOD_CACHE[key] = member;
  return member;
}

function getDateMember(target, key) {
  if (Object.prototype.hasOwnProperty.call(DATE_METHOD_CACHE, key)) {
    return DATE_METHOD_CACHE[key];
  }

  let member;
  switch (key) {
    case "getTime":
      member = new NativeFunction("Date.getTime", ({ thisValue }) => thisValue.timestamp);
      break;
    case "getFullYear":
      member = new NativeFunction("Date.getFullYear", ({ thisValue }) => new Date(thisValue.timestamp).getUTCFullYear());
      break;
    case "getMonth":
      member = new NativeFunction("Date.getMonth", ({ thisValue }) => new Date(thisValue.timestamp).getUTCMonth());
      break;
    case "getDate":
      member = new NativeFunction("Date.getDate", ({ thisValue }) => new Date(thisValue.timestamp).getUTCDate());
      break;
    case "getDay":
      member = new NativeFunction("Date.getDay", ({ thisValue }) => new Date(thisValue.timestamp).getUTCDay());
      break;
    case "getHours":
      member = new NativeFunction("Date.getHours", ({ thisValue }) => new Date(thisValue.timestamp).getUTCHours());
      break;
    case "getMinutes":
      member = new NativeFunction("Date.getMinutes", ({ thisValue }) => new Date(thisValue.timestamp).getUTCMinutes());
      break;
    case "getSeconds":
      member = new NativeFunction("Date.getSeconds", ({ thisValue }) => new Date(thisValue.timestamp).getUTCSeconds());
      break;
    case "getMilliseconds":
      member = new NativeFunction("Date.getMilliseconds", ({ thisValue }) => new Date(thisValue.timestamp).getUTCMilliseconds());
      break;
    case "toISOString":
      member = new NativeFunction("Date.toISOString", ({ thisValue }) => new Date(thisValue.timestamp).toISOString());
      break;
    case "toString":
      member = new NativeFunction("Date.toString", ({ thisValue }) => dateToString(thisValue.timestamp));
      break;
    case "toLocaleDateString":
      member = new NativeFunction("Date.toLocaleDateString", ({ thisValue }) => dateToLocaleDateString(thisValue.timestamp));
      break;
    case "valueOf":
      member = new NativeFunction("Date.valueOf", ({ thisValue }) => thisValue.timestamp);
      break;
    case "setTime":
      member = new NativeFunction("Date.setTime", ({ args, thisValue }) => {
        thisValue.timestamp = toJsNumber(args[0]);
        return thisValue.timestamp;
      });
      break;
    default:
      return undefined;
  }

  DATE_METHOD_CACHE[key] = member;
  return member;
}

function getRegexMember(target, key) {
  switch (key) {
    case "source":
      return target.pattern;
    case "flags":
      return target.flags;
    case "global":
      return target.flags.includes("g");
    case "ignoreCase":
      return target.flags.includes("i");
    case "multiline":
      return target.flags.includes("m");
    case "lastIndex":
      return target.lastIndex;
    case "test":
      if (Object.prototype.hasOwnProperty.call(REGEX_METHOD_CACHE, key)) {
        return REGEX_METHOD_CACHE[key];
      }
      REGEX_METHOD_CACHE[key] = new NativeFunction("RegExp.test", ({ args, thisValue }) => {
        const match = execMatch(thisValue, String(args[0] ?? ""), false);
        return match !== null;
      });
      return REGEX_METHOD_CACHE[key];
    case "exec":
      if (Object.prototype.hasOwnProperty.call(REGEX_METHOD_CACHE, key)) {
        return REGEX_METHOD_CACHE[key];
      }
      REGEX_METHOD_CACHE[key] = new NativeFunction("RegExp.exec", ({ args, thisValue }) =>
        execMatch(thisValue, String(args[0] ?? ""), false)
      );
      return REGEX_METHOD_CACHE[key];
    case "toString":
      if (Object.prototype.hasOwnProperty.call(REGEX_METHOD_CACHE, key)) {
        return REGEX_METHOD_CACHE[key];
      }
      REGEX_METHOD_CACHE[key] = new NativeFunction("RegExp.toString", ({ thisValue }) => `/${thisValue.pattern}/${thisValue.flags}`);
      return REGEX_METHOD_CACHE[key];
    default:
      return undefined;
  }
}

function ensureArrayReceiver(value, method) {
  if (!Array.isArray(value)) {
    throw new JSLiteRuntimeError(`Array.${method} called on non-array value`);
  }
}

function isUserFunction(value) {
  return Boolean(
    value &&
    typeof value.callFromInterpreter === "function" &&
    typeof value.constructFromInterpreter === "function" &&
    value.isUserFunction === true
  );
}

function reduceArray(values, callback, initialValue, interpreter, rightToLeft) {
  if (!Array.isArray(values)) {
    throw new JSLiteRuntimeError("Reduce target must be an array");
  }

  const step = rightToLeft ? -1 : 1;
  let index = rightToLeft ? values.length - 1 : 0;
  let accumulator;

  if (initialValue !== undefined) {
    accumulator = initialValue;
  } else {
    if (values.length === 0) {
      throw new JSLiteRuntimeError("Reduce of empty array with no initial value");
    }
    accumulator = values[index];
    index += step;
  }

  for (; index >= 0 && index < values.length; index += step) {
    accumulator = callFunction(
      callback,
      [accumulator, values[index], index, values],
      undefined,
      interpreter
    );
  }

  return accumulator;
}

function flattenArray(values, depth) {
  const maxDepth = depth < 0 ? 0 : depth;
  const result = [];
  for (const value of values) {
    if (Array.isArray(value) && maxDepth > 0) {
      result.push(...flattenArray(value, maxDepth - 1));
    } else {
      result.push(value);
    }
  }
  return result;
}

function replaceString(sourceValue, searchValue, replaceValue, interpreter, replaceAll) {
  const source = String(sourceValue);

  if (searchValue instanceof JSLiteRegExp) {
    const flags = replaceAll && !searchValue.flags.includes("g")
      ? `${searchValue.flags}g`
      : searchValue.flags;
    const native = new RegExp(searchValue.pattern, flags);
    return source.replace(native, (...nativeArgs) =>
      computeReplacement(nativeArgs, replaceValue, interpreter)
    );
  }

  const search = String(searchValue ?? "");
  const replacer = (...nativeArgs) => computeReplacement(nativeArgs, replaceValue, interpreter);
  if (replaceAll) {
    return source.replaceAll(search, (...nativeArgs) => replacer(...nativeArgs));
  }
  return source.replace(search, (...nativeArgs) => replacer(...nativeArgs));
}

function computeReplacement(nativeArgs, replaceValue, interpreter) {
  const [match] = nativeArgs;
  const hasGroupsObject = nativeArgs.length > 1 && nativeArgs[nativeArgs.length - 1] !== null &&
    typeof nativeArgs[nativeArgs.length - 1] === "object";
  const source = nativeArgs[hasGroupsObject ? nativeArgs.length - 2 : nativeArgs.length - 1];
  const offset = nativeArgs[hasGroupsObject ? nativeArgs.length - 3 : nativeArgs.length - 2];
  const captures = nativeArgs.slice(1, hasGroupsObject ? -3 : -2);
  if (replaceValue instanceof NativeFunction || isUserFunction(replaceValue)) {
    return toJsString(
      callFunction(replaceValue, [match, ...captures, offset, source], undefined, interpreter)
    );
  }
  return String(replaceValue ?? "");
}

function toRegExpValue(value) {
  if (value instanceof JSLiteRegExp) {
    return value;
  }
  if (value instanceof RegExp) {
    return new JSLiteRegExp(value.source, value.flags);
  }
  return null;
}

function execMatch(regexp, source, preserveRegexState) {
  const native = regexp.toNative();
  native.lastIndex = regexp.flags.includes("g") ? regexp.lastIndex : 0;
  const match = native.exec(source);

  if (regexp.flags.includes("g")) {
    regexp.lastIndex = match ? native.lastIndex : 0;
  }

  if (!match) {
    return preserveRegexState ? null : null;
  }

  const result = Array.from(match);
  result.index = stringLength(source.slice(0, match.index));
  result.input = source;
  return result;
}

function constructDate(args) {
  if (args.length === 0) {
    return new JSLiteDate(Date.now());
  }

  if (args.length === 1) {
    return new JSLiteDate(toJsNumber(args[0]));
  }

  const year = Math.trunc(toJsNumber(args[0]));
  const month = Math.trunc(toJsNumber(args[1]));
  const day = args[2] === undefined ? 1 : Math.trunc(toJsNumber(args[2]));
  const hours = args[3] === undefined ? 0 : Math.trunc(toJsNumber(args[3]));
  const minutes = args[4] === undefined ? 0 : Math.trunc(toJsNumber(args[4]));
  const seconds = args[5] === undefined ? 0 : Math.trunc(toJsNumber(args[5]));
  const milliseconds = args[6] === undefined ? 0 : Math.trunc(toJsNumber(args[6]));

  return new JSLiteDate(Date.UTC(year, month, day, hours, minutes, seconds, milliseconds));
}

function dateToString(timestamp) {
  return new Date(timestamp).toUTCString().replace("GMT", "GMT+0000 (UTC)");
}

function dateToLocaleDateString(timestamp) {
  const date = new Date(timestamp);
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}/${date.getUTCFullYear()}`;
}
