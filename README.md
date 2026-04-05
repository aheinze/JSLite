# JSLite

`JSLite` is a quick and dirty sandboxed JavaScript runner with a small `Engine` facade.

Execution is parser-based only. Source is tokenized, parsed, compiled into JSLite's internal program format, and executed by the repo's own runtime. Where the bytecode compiler supports a construct it is used automatically; otherwise execution falls back to the AST interpreter. There is no `node:vm` path and no alternate engine backend.

## What It Supports

- The practical language surface covered by the local compatibility suite:
  - arithmetic, comparisons, logical operators, nullish coalescing
  - `var` / `let` / `const`
  - functions, closures, recursion, arrow functions
  - arrays, objects, destructuring, spread/rest
  - `if`, loops, `switch`, `try/catch/finally`, top-level `return`
  - regexes, template literals, `Date`, `Math`, `JSON`, `Number`, `String`
  - optional chaining, `new`, `this`, prototype methods
- `Engine` facade methods:
  - `eval`
  - `compile`
  - `run`
  - `getOutput`
  - `getOutputLines`

## Sandbox Notes

- Source is tokenized, parsed, and executed inside the repo's own interpreter/runtime.
- The runtime only exposes the builtins explicitly provided by `JSLite`.
- There is no host `eval`, `Function`, `require`, `process`, `module`, `exports`, `Buffer`, or timer access from user scripts.
- Console output is captured and exposed via `getOutput()`.
- This is still a pragmatic sandbox, not a formal security boundary.

## API

```js
import { Engine } from "./src/index.js";

const engine = new Engine();

const result = engine.eval(`
  function fib(n) {
    if (n <= 1) return n;
    return fib(n - 1) + fib(n - 2);
  }

  console.log("fib(6)", fib(6));
  fib(10);
`);

console.log(result); // 55
console.log(engine.getOutput()); // "fib(6) 8\n"
```

### Compile Once

```js
import { Engine } from "./src/index.js";

const engine = new Engine();
const program = engine.compile("x * 2");

console.log(engine.run(program, { x: 21 })); // 42
```

### Engine Notes

- Repeated `compile()` and `eval()` calls reuse compiled programs per `Engine` instance when the source string is identical.
- `compile()` also precomputes function hoists, identifier slot resolution, and bytecode where supported so `run()` avoids repeated parsing and most name-based scope walks.

## Browser

`JSLite` is browser-safe in architecture. It is plain ESM with no `node:vm` dependency.

Serve the repo over HTTP before testing browser modules:

```bash
npm run serve:example
```

Then open:

- `http://localhost:8000/examples/browser.html`

### Browser ESM Example

```html
<script type="module">
  import { Engine } from "./src/index.js";

  class Counter {
    constructor(value = 0) {
      this.value = value;
    }

    inc(step = 1) {
      this.value += step;
      return this.value;
    }
  }

  const engine = new Engine();
  const globals = {
    double: (n) => n * 2,
    counter: new Counter(1),
    Counter,
  };

  const result = engine.eval(`
    counter.inc(2);
    ({
      current: counter.value,
      doubled: double(counter.value),
      sameType: counter instanceof Counter,
      constructed: new Counter(9).value
    });
  `, globals);

  console.log(result);
</script>
```

### Browser Bundle Example

Build the browser bundle first:

```bash
npm run build
```

Then import the bundled file:

```html
<script type="module">
  import { Engine } from "./dist/jslite.esm.js";

  const engine = new Engine();
  console.log(engine.eval("21 * 2"));
</script>
```

Notes:

- Globals may include plain values, callable functions, and imported class instances.
- Imported host objects use the runtime proxy bridge, so property access and method calls stay inside the sandbox boundary.
- Top-level `return` exits the script early, so browser snippets can use `return` as a final result.
- `console.log(...)` inside the sandbox is captured through `engine.getOutput()`.

## CLI

```bash
node bin/jslite.js -e 'var x = 20; x + 22;'
node bin/jslite.js --globals '{"name":"Ada"}' -e 'name'
node bin/jslite.js ./some-script.js
```

If the package is installed globally or linked, the same commands can be run as `jslite ...`.

## Development

The test suite uses a frozen compatibility fixture in [compat-cases.json](/home/artur/DEV/JSLite/tests/compat-cases.json) plus a small set of direct regression tests.

Main test files:

- [compat-cases.json](/home/artur/DEV/JSLite/tests/compat-cases.json)
- [compat-ported.test.js](/home/artur/DEV/JSLite/tests/compat-ported.test.js)
- [compat-manual.test.js](/home/artur/DEV/JSLite/tests/compat-manual.test.js)
- [browser.html](/home/artur/DEV/JSLite/examples/browser.html)

Run the suite:

```bash
npm test
```

