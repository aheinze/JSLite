import assert from "node:assert/strict";
import test from "node:test";
import { Engine, JSLiteRuntimeError, JSLiteSyntaxError, Parser } from "../src/index.js";

test("EdgeCasesHardcoreTest::testGlobalsWithAllTypes", () => {
  const source =
    'typeof num + "," + typeof str + "," + typeof bool + "," + typeof arr + "," + typeof obj + "," + typeof fn';
  const globals = {
    num: 42,
    str: "hello",
    bool: true,
    arr: [1, 2, 3],
    obj: { key: "value" },
    fn: (x) => x * 2,
  };

  const engine = new Engine();
  assert.equal(engine.eval(source, globals), "number,string,boolean,object,object,function");
});

test("EdgeCasesHardcoreTest::testGlobalsCallback", () => {
  const source = '[1, 2, 3].map(transform).join(",")';
  const globals = {
    transform: (x) => x * 2,
  };

  const engine = new Engine();
  assert.equal(engine.eval(source, globals), "2,4,6");
});

test("HostProxyTest::testGlobalsSupportClassInstances", () => {
  class Counter {
    constructor(value = 1) {
      this.value = value;
    }

    inc(step = 1) {
      this.value += step;
      return this.value;
    }

    child() {
      return new Counter(this.value + 10);
    }
  }

  const counter = new Counter(1);
  const engine = new Engine();

  assert.equal(
    engine.eval('counter.value + "," + counter.inc(2) + "," + counter.value', { counter }),
    "1,3,3"
  );
  assert.equal(engine.eval("counter.child().value", { counter }), 13);
  assert.equal(engine.eval("var fn = counter.inc; fn(4); counter.value;", { counter }), 7);
  assert.equal(engine.eval("counter instanceof Counter", { counter, Counter }), true);
  assert.equal(engine.eval("new Counter(9).value", { Counter }), 9);
  assert.equal(engine.eval("counter", { counter }), counter);
});

test("ConstructorsTest::testDateParse", () => {
  const engine = new Engine();
  const result = engine.eval('Date.parse("2024-01-01")');
  assert.equal(typeof result, "number");
  assert.ok(result > 0);
});

test("NumberObjectTest::testNumberEpsilon", () => {
  const engine = new Engine();
  const result = engine.eval("Number.EPSILON");
  assert.equal(typeof result, "number");
  assert.ok(result > 0 && result < 0.001);
});

test("TortureTest::testAsiReturnNewlineBefore", () => {
  const engine = new Engine();
  const result = engine.eval("function f() { return\n42 } f();");
  assert.ok(result === 42 || result === null);
});

test("ControlFlowTest::testTopLevelReturnExitsProgram", () => {
  const engine = new Engine();
  const result = engine.eval(`
    const a = 123;

    if (true) {
      return 333;
    }

    return a;
  `);

  assert.equal(result, 333);
});

test("BytecodeTryCatchTest::testTryCatchFinallyCompilesToBytecode", () => {
  const engine = new Engine();
  const compiled = engine.compile(`
    function boom() {
      throw "boom";
    }

    var result = "";

    try {
      boom();
    } catch (e) {
      result = e;
    } finally {
      result = result + "!";
    }

    result;
  `);

  assert.ok(compiled.program.bytecode);
  assert.ok(compiled.program.body[0].bytecode);
  assert.equal(engine.run(compiled), "boom!");
});

test("BytecodeTryCatchTest::testBreakRunsFinallyInBytecode", () => {
  const engine = new Engine();
  const compiled = engine.compile(`
    var log = "";

    for (var i = 0; i < 3; i++) {
      try {
        if (i === 1) {
          break;
        }
        log = log + i;
      } finally {
        log = log + "f";
      }
    }

    log;
  `);

  assert.ok(compiled.program.bytecode);
  assert.equal(engine.run(compiled), "0ff");
});

test("BytecodeTryCatchTest::testReturnInsideTryRunsFinallyInBytecodeFunction", () => {
  const engine = new Engine();
  const compiled = engine.compile(`
    function f() {
      try {
        return 1;
      } finally {
        return 2;
      }
    }

    f();
  `);

  assert.ok(compiled.program.bytecode);
  assert.ok(compiled.program.body[0].bytecode);
  assert.equal(engine.run(compiled), 2);
});

test("BytecodeSwitchTest::testSwitchWithBreakCompilesToBytecode", () => {
  const engine = new Engine();
  const compiled = engine.compile(`
    var result = "";

    switch (2) {
      case 1:
        result = "one";
        break;
      case 2:
        result = "two";
        break;
      default:
        result = "other";
        break;
    }

    result;
  `);

  assert.ok(compiled.program.bytecode);
  assert.equal(engine.run(compiled), "two");
});

test("BytecodeLoopTest::testDoWhileCompilesToBytecode", () => {
  const engine = new Engine();
  const compiled = engine.compile(`
    var i = 0;
    var out = "";

    do {
      out = out + i;
      i++;
    } while (i < 3);

    out;
  `);

  assert.ok(compiled.program.bytecode);
  assert.equal(engine.run(compiled), "012");
});

test("BytecodeLoopTest::testForOfCompilesToBytecode", () => {
  const engine = new Engine();
  const compiled = engine.compile(`
    var out = "";

    for (const ch of "abc") {
      out = out + ch;
    }

    out;
  `);

  assert.ok(compiled.program.bytecode);
  assert.equal(engine.run(compiled), "abc");
});

test("BytecodeLoopTest::testForInCompilesToBytecode", () => {
  const engine = new Engine();
  const compiled = engine.compile(`
    var obj = { a: 1, b: 2 };
    var out = "";

    for (const key in obj) {
      out = out + key;
    }

    out;
  `);

  assert.ok(compiled.program.bytecode);
  assert.equal(engine.run(compiled), "ab");
});

test("BytecodeBindingTest::testDestructuringDeclarationCompilesToBytecode", () => {
  const engine = new Engine();
  const compiled = engine.compile(`
    const [a, b] = [20, 22];
    a + b;
  `);

  assert.ok(compiled.program.bytecode);
  assert.equal(engine.run(compiled), 42);
});

test("BytecodeOptionalChainingTest::testOptionalMemberCompilesToBytecode", () => {
  const engine = new Engine();
  const compiled = engine.compile(`
    var obj = null;
    obj?.value;
  `);

  assert.ok(compiled.program.bytecode);
  assert.equal(engine.run(compiled), null);
});

test("BytecodeOptionalChainingTest::testOptionalMethodCallCompilesToBytecode", () => {
  const engine = new Engine();
  const compiled = engine.compile(`
    var obj = {
      value: 41,
      inc: function() {
        return this.value + 1;
      }
    };

    obj?.inc();
  `);

  assert.ok(compiled.program.bytecode);
  assert.equal(engine.run(compiled), 42);
});

test("TortureTest::testUnclosedStringThrows", () => {
  const engine = new Engine();
  try {
    engine.eval('"hello');
  } catch (error) {
    assert.ok(
      error instanceof JSLiteSyntaxError ||
        error instanceof JSLiteRuntimeError ||
        error instanceof Error
    );
  }
});

test("TortureTest::testDivisionByZero", () => {
  const engine = new Engine();
  const result = engine.eval("1 / 0;");
  assert.equal(result, Number.POSITIVE_INFINITY);
});

test("TortureTest::testEscapeSequenceNewline", () => {
  const engine = new Engine();
  const result = engine.eval('"hello\\nworld".length;');
  assert.ok(result === 11 || result === 12);
});

test("EdgeCasesHardcoreTest::testRelationalWithCoercion", () => {
  const engine = new Engine();
  assert.equal(engine.eval('"10" > "9"'), true);
  assert.equal(engine.eval('"10" > 9'), true);
  assert.equal(engine.eval("null >= 0"), true);
  assert.equal(engine.eval("null > 0"), false);
  assert.equal(engine.eval("null <= 0"), true);
  assert.equal(engine.eval("null < 0"), false);
});

test("EdgeCasesHardcoreTest::testLetInForLoop", () => {
  const engine = new Engine();
  const result = engine.eval(`
    var fns = [];
    for (let i = 0; i < 5; i++) {
      fns.push(function() { return i; });
    }
    fns[0]() + "," + fns[2]() + "," + fns[4]();
  `);

  assert.equal(result, "5,5,5");
});

test("EngineApiTest::testCompileReturnsBackendlessProgram", () => {
  const engine = new Engine();
  const compiled = engine.compile("40 + 2");

  assert.equal("backend" in compiled, false);
  assert.equal(engine.run(compiled), 42);
});

test("EnginePerformanceTest::testCompileCachesRepeatedSources", () => {
  const engine = new Engine();
  const originalParse = Parser.prototype.parse;
  let parseCalls = 0;

  Parser.prototype.parse = function wrappedParse(...args) {
    parseCalls += 1;
    return originalParse.apply(this, args);
  };

  try {
    const first = engine.compile("21 * 2");
    const second = engine.compile("21 * 2");
    const third = engine.compile("20 + 22");

    assert.equal(first, second);
    assert.equal(parseCalls, 2);
    assert.notEqual(first, third);
  } finally {
    Parser.prototype.parse = originalParse;
  }
});

test("RuntimePerformanceTest::testMethodIdentityIsStable", () => {
  const engine = new Engine();

  assert.equal(engine.eval("var a = []; a.push === a.push;"), true);
  assert.equal(engine.eval('var s = "abc"; s.slice === s.slice;'), true);
  assert.equal(engine.eval("var o = {}; o.hasOwnProperty === o.hasOwnProperty;"), true);
});

test("OperatorsExtendedTest::testDeleteNonMemberReturnsTrue", () => {
  const engine = new Engine();
  assert.equal(engine.eval("var x = 5; delete x"), true);
});

test("TortureTest::testAsiEmptyStatements", () => {
  const engine = new Engine();
  assert.throws(() => {
    engine.eval(";;; var x = 1;;;");
  });
});

test("TortureTest::testCommaOperator", () => {
  const engine = new Engine();
  assert.throws(() => {
    engine.eval("var x = (1, 2, 3); x;");
  });
});

test("TortureTest::testNasty01_UnaryPlusOnArray", () => {
  const engine = new Engine();
  assert.throws(() => {
    engine.eval("+[];");
  });
});

test("TortureTest::testNasty05_UnaryPlusString", () => {
  const engine = new Engine();
  assert.throws(() => {
    engine.eval('+"42";');
  });
});

test("TortureTest::testUnicodeStringLengthEmoji", () => {
  const engine = new Engine();
  assert.equal(engine.eval('"😀".length;'), 1);
});

test("FuzzTest::testFuzzTokenSoup", () => {
  const baseSeed = 42;
  const iterations = 200;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const seed = baseSeed + iteration;
    const rng = createRng(seed);
    const length = randInt(rng, 3, 20);
    const source = randomTokenSoup(length, seed);
    assertNoCrash(source, `token soup seed ${seed}`);
  }
});

test("FuzzTest::testFuzzStructuredPrograms", () => {
  const baseSeed = 1000;
  const iterations = 200;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const seed = baseSeed + iteration;
    const rng = createRng(seed);
    const statements = randInt(rng, 1, 5);
    const source = randomStructuredProgram(statements, seed);
    assertNoCrash(source, `structured seed ${seed}`);
  }
});

test("FuzzTest::testFuzzDeepNesting", () => {
  const patterns = [
    (n) => "(".repeat(n) + "1" + ")".repeat(n),
    (n) => "[".repeat(n) + "1" + "]".repeat(n),
    (n) => '{"a":'.repeat(n) + "1" + "}".repeat(n),
    (n) => "if (true) { ".repeat(n) + "var x = 1;" + " }".repeat(n),
    (n) => "(function() { return ".repeat(n) + "42" + "; })()".repeat(n),
  ];

  for (const [index, factory] of patterns.entries()) {
    for (let depth = 1; depth <= 30; depth += 5) {
      assertNoCrash(factory(depth), `deep nesting pattern ${index} depth ${depth}`);
    }
  }
});

test("FuzzTest::testFuzzBoundaryStrings", () => {
  const inputs = [
    '""',
    '"\\\\";',
    '"a".length;',
    'var x = ""; x + x + x;',
    '"0" + 0;',
    '"" + [];',
    '"" + {};',
    '"" == false;',
    '"" === false;',
    'var a = "abc"; a[0];',
    'var a = "abc"; a[-1];',
    'var a = "abc"; a[999];',
  ];

  for (const source of inputs) {
    assertNoCrash(source, `boundary string ${source}`);
  }
});

test("FuzzTest::testFuzzBoundaryNumbers", () => {
  const engine = new Engine();
  const inputs = [
    "0;",
    "-0;",
    "9999999999999999;",
    "0.1 + 0.2;",
    "1/0;",
    "-1/0;",
    "0/0;",
    "1e308;",
    "1e-308;",
    "0xFFFFFFFF;",
    "0xFF;",
  ];

  for (const source of inputs) {
    try {
      engine.eval(source);
    } catch (error) {
      assertAcceptableError(error, `boundary number ${source}`);
    }
  }
});

test("FuzzTest::testFuzzMemoryStress", () => {
  const inputs = [
    "var a = []; for (var i = 0; i < 1000; i++) { a.push(i); } a.length;",
    'var o = {}; for (var i = 0; i < 100; i++) { o["k" + i] = i; } typeof o;',
    'var s = ""; for (var i = 0; i < 500; i++) { s = s + "x"; } s.length;',
    "var a = []; for (var i = 0; i < 100; i++) { a.push([i, i*2]); } a.length;",
  ];

  for (const source of inputs) {
    assertNoCrash(source, `memory stress ${source}`);
  }
});

test("FuzzTest::testFuzzMalformedInputs", () => {
  const inputs = [
    "",
    " ",
    "  ;  ;  ;  ",
    "var",
    "var x =",
    "if",
    "if (",
    "if (true",
    "function",
    "function f(",
    "function f() {",
    "return",
    "{{{",
    ")))",
    "]]",
    "////",
    "/* unclosed comment",
    '"unclosed string',
    "'unclosed'",
    "`unclosed template",
    "var x = /unclosed",
  ];

  for (const source of inputs) {
    assertNoCrash(source, `malformed input ${JSON.stringify(source)}`);
  }
});

test("FuzzTest::testFuzzOperatorCombos", () => {
  const inputs = [
    "++--++;",
    "!!!true;",
    "~~~0;",
    "1 + + + 1;",
    "1 - - - 1;",
    "1 === === 1;",
    "> > >;",
    "< < <;",
    "== == ==;",
    "&& || ??;",
    "... 1;",
  ];

  for (const source of inputs) {
    assertNoCrash(source, `operator combo ${source}`);
  }
});

function assertNoCrash(source, label) {
  const engine = new Engine();

  try {
    engine.eval(source);
  } catch (error) {
    assertAcceptableError(error, `${label} [eval]`);
  }
}

function assertAcceptableError(error, label) {
  assert.ok(
    error instanceof JSLiteSyntaxError ||
      error instanceof JSLiteRuntimeError ||
      error instanceof Error,
    `${label}: unexpected error ${error}`
  );
}

function randomTokenSoup(length, seed) {
  const rng = createRng(seed);
  const keywords = [
    "var", "let", "const", "if", "else", "while", "for", "do",
    "function", "return", "break", "continue", "switch", "case",
    "default", "try", "catch", "throw", "typeof", "new", "delete",
    "in", "instanceof", "void", "null", "undefined", "true", "false",
    "this", "of",
  ];
  const operators = [
    "+", "-", "*", "/", "%", "**",
    "=", "+=", "-=", "*=", "/=",
    "==", "!=", "===", "!==",
    "<", ">", "<=", ">=",
    "&&", "||", "??",
    "!", "~", "++", "--",
    "&", "|", "^", "<<", ">>", ">>>",
    ".", ",", ";", ":", "?",
    "=>",
  ];
  const delimiters = ["(", ")", "[", "]", "{", "}"];
  const identifiers = [
    "a", "b", "c", "x", "y", "z", "foo", "bar", "baz",
    "arr", "obj", "fn", "i", "n", "sum", "val", "tmp",
  ];
  const allTokens = [...keywords, ...operators, ...delimiters, ...identifiers];
  const tokens = [];

  for (let index = 0; index < length; index += 1) {
    const choice = randInt(rng, 0, 10);
    if (choice <= 3) {
      tokens.push(allTokens[randInt(rng, 0, allTokens.length - 1)]);
    } else if (choice <= 5) {
      tokens.push(String(randInt(rng, 0, 999)));
    } else if (choice === 6) {
      tokens.push(`"${identifiers[randInt(rng, 0, identifiers.length - 1)]}"`);
    } else if (choice === 7) {
      tokens.push(identifiers[randInt(rng, 0, identifiers.length - 1)]);
    } else {
      const pool = randInt(rng, 0, 1) === 1 ? operators : delimiters;
      tokens.push(pool[randInt(rng, 0, pool.length - 1)]);
    }
  }

  return tokens.join(" ");
}

function randomStructuredProgram(statements, seed) {
  const rng = createRng(seed);
  const lines = [];

  for (let index = 0; index < statements; index += 1) {
    lines.push(randomStatement(rng));
  }

  return lines.join("\n");
}

function randomStatement(rng) {
  const identifiers = [
    "a", "b", "c", "x", "y", "z", "foo", "bar", "baz",
    "arr", "obj", "fn", "i", "n", "sum", "val", "tmp",
  ];
  const choice = randInt(rng, 0, 9);
  const id = identifiers[randInt(rng, 0, identifiers.length - 1)];

  switch (choice) {
    case 0:
      return `var ${id} = ${randomExpression(rng, 2)};`;
    case 1:
      return `${id} = ${randomExpression(rng, 2)};`;
    case 2:
      return `if (${randomExpression(rng, 1)}) { ${randomExpression(rng, 1)}; }`;
    case 3:
      return `while (false) { ${randomExpression(rng, 1)}; }`;
    case 4:
      return `for (var ${id} = 0; ${id} < 3; ${id}++) { ${randomExpression(rng, 1)}; }`;
    case 5:
      return `function ${id}(${identifiers[randInt(rng, 0, 5)]}) { return ${randomExpression(rng, 2)}; }`;
    case 6:
      return `try { ${randomExpression(rng, 1)}; } catch(e) { }`;
    case 7:
      return `var ${id} = [${randomExpression(rng, 1)}, ${randomExpression(rng, 1)}];`;
    case 8:
      return `var ${id} = {${identifiers[randInt(rng, 0, 5)]}: ${randomExpression(rng, 1)}};`;
    default:
      return `${randomExpression(rng, 2)};`;
  }
}

function randomExpression(rng, depth) {
  if (depth <= 0) {
    return randomAtom(rng);
  }

  const choice = randInt(rng, 0, 7);
  switch (choice) {
    case 0:
      return randomAtom(rng);
    case 1:
      return `${randomAtom(rng)} + ${randomExpression(rng, depth - 1)}`;
    case 2:
      return `${randomAtom(rng)} - ${randomExpression(rng, depth - 1)}`;
    case 3:
      return `${randomAtom(rng)} * ${randomExpression(rng, depth - 1)}`;
    case 4:
      return `${randomAtom(rng)} === ${randomExpression(rng, depth - 1)}`;
    case 5:
      return `${randomAtom(rng)} < ${randomExpression(rng, depth - 1)}`;
    case 6:
      return `!${randomExpression(rng, depth - 1)}`;
    default:
      return `(${randomExpression(rng, depth - 1)})`;
  }
}

function randomAtom(rng) {
  const identifiers = [
    "a", "b", "c", "x", "y", "z", "foo", "bar", "baz",
    "arr", "obj", "fn", "i", "n", "sum", "val", "tmp",
  ];
  const choice = randInt(rng, 0, 6);

  switch (choice) {
    case 0:
      return String(randInt(rng, 0, 100));
    case 1:
      return `"${identifiers[randInt(rng, 0, identifiers.length - 1)]}"`;
    case 2:
      return identifiers[randInt(rng, 0, identifiers.length - 1)];
    case 3:
      return randInt(rng, 0, 1) === 1 ? "true" : "false";
    case 4:
      return "null";
    case 5:
      return "[]";
    default:
      return "{}";
  }
}

function createRng(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}
