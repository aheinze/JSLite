import assert from "node:assert/strict";
import { Engine } from "../../src/index.js";

export function buildCaseGroups(cases) {
  const groups = new Map();

  for (const testCase of cases) {
    if (!supportsMarker(testCase.actual)) {
      continue;
    }

    if (containsUnsupportedValue(testCase)) {
      continue;
    }

    const key = caseLabel(testCase);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(testCase);
  }

  return groups;
}

export function containsUnsupportedValue(value) {
  if (Array.isArray(value)) {
    return value.some((entry) => containsUnsupportedValue(entry));
  }

  if (!value || typeof value !== "object") {
    return false;
  }

  if (value.__unsupportedClosure || value.__unsupportedObject) {
    return true;
  }

  return Object.values(value).some((entry) => containsUnsupportedValue(entry));
}

export function executeMarker(marker) {
  const engine = new Engine();
  const result = executeWithEngine(engine, marker);
  return applyPath(result, marker.path ?? []);
}

function executeWithEngine(engine, marker) {
  switch (marker.kind) {
    case "eval": {
      const { source, globals } = marker.payload;
      return engine.eval(source, globals);
    }
    case "run": {
      const { source, globals } = marker.payload;
      const compiled = engine.compile(source);
      return engine.run(compiled, globals);
    }
    case "output":
      if (marker.payload.after) {
        executeWithEngine(engine, marker.payload.after);
      }
      return engine.getOutput();
    default:
      throw new Error(`Unsupported marker kind '${marker.kind}'`);
  }
}

function supportsMarker(marker) {
  if (!marker || typeof marker !== "object") {
    return true;
  }

  if (marker.kind === "eval" || marker.kind === "run") {
    return true;
  }

  if (marker.kind === "output") {
    return supportsMarker(marker.payload?.after);
  }

  return false;
}

function applyPath(value, path) {
  let current = value;

  for (const segment of path) {
    if (current == null) {
      return current;
    }

    current = current[segment.key];
  }

  return current;
}

export function assertCase(testCase) {
  if (testCase.assertion === "throws") {
    assert.throws(
      () => executeMarker(testCase.actual),
      (error) => {
        if (testCase.expectedExceptionMessage) {
          const combined = `${error.name}: ${error.message}`;
          assert.match(combined, new RegExp(escapeRegExp(testCase.expectedExceptionMessage), "i"));
        }
        return true;
      },
      caseLabel(testCase)
    );
    return;
  }

  const actual = normalizeValue(executeMarker(testCase.actual));

  switch (testCase.assertion) {
    case "same":
      assert.deepStrictEqual(actual, normalizeValue(testCase.expected), caseLabel(testCase));
      return;
    case "equalsWithDelta":
      assert.equal(typeof actual, "number", caseLabel(testCase));
      if (testCase.actual.payload?.source === "Date.now()") {
        const now = Date.now();
        assert.ok(
          Math.abs(actual - now) <= testCase.delta,
          `${caseLabel(testCase)} expected current time ± ${testCase.delta}, got ${actual}`
        );
        return;
      }
      assert.ok(
        Math.abs(actual - normalizeNumber(testCase.expected)) <= testCase.delta,
        `${caseLabel(testCase)} expected ${testCase.expected} ± ${testCase.delta}, got ${actual}`
      );
      return;
    case "contains":
      assert.equal(typeof actual, "string", caseLabel(testCase));
      assert.match(actual, new RegExp(escapeRegExp(testCase.needle)));
      return;
    case "isNumeric":
      assert.ok(isNumericLike(actual), caseLabel(testCase));
      return;
    case "count":
      assert.equal(getCount(actual), testCase.expected, caseLabel(testCase));
      return;
    case "true":
      assert.equal(actual, true, caseLabel(testCase));
      return;
    case "false":
      assert.equal(actual, false, caseLabel(testCase));
      return;
    case "null":
      assert.equal(actual, null, caseLabel(testCase));
      return;
    case "nan":
      assert.ok(Number.isNaN(actual), caseLabel(testCase));
      return;
    case "isFloat":
      assert.equal(typeof actual, "number", caseLabel(testCase));
      return;
    case "notNull":
      assert.notEqual(actual, null, caseLabel(testCase));
      return;
    default:
      throw new Error(`Unsupported assertion '${testCase.assertion}'`);
  }
}

export function normalizeValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry));
  }

  if (!value || typeof value !== "object") {
    if (typeof value === "number" && Object.is(value, -0)) {
      return 0;
    }
    return value;
  }

  if (value.__nan) {
    return Number.NaN;
  }

  if (value.__infinity) {
    return value.__infinity > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  }

  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = normalizeValue(entry);
  }
  return result;
}

function normalizeNumber(value) {
  const normalized = normalizeValue(value);
  if (typeof normalized !== "number") {
    throw new TypeError(`Expected numeric value, got ${typeof normalized}`);
  }
  return normalized;
}

function caseLabel(testCase) {
  return `${testCase.file}::${testCase.method}`;
}

function getCount(value) {
  if (Array.isArray(value) || typeof value === "string") {
    return value.length;
  }

  if (value && typeof value === "object") {
    return Object.keys(value).length;
  }

  throw new TypeError("Value does not have a count");
}

function isNumericLike(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) || Number.isNaN(value) || !Number.isFinite(value);
  }

  if (typeof value === "string") {
    return value.trim() !== "" && Number.isFinite(Number(value));
  }

  return false;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
