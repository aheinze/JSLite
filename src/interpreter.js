import { executeBytecode } from "./bytecode.js";
import { Environment } from "./environment.js";
import { JSLiteRuntimeError } from "./errors.js";
import {
  callFunction,
  compareRelationalValues,
  constructValue,
  createBuiltins,
  createDictionary,
  deleteProperty,
  fromHostValue,
  hasProperty,
  instanceOfValue,
  isNullish,
  isTruthy,
  JSLiteRegExp,
  safeGet,
  safeSet,
  toJsNumber,
  toJsString,
  typeOf,
} from "./runtime.js";
import { BreakSignal, ContinueSignal, ReturnSignal, ThrownSignal } from "./signals.js";

class UserFunction {
  constructor(name, params, body, closure, scope, options = {}) {
    this.name = name || "anonymous";
    this.params = params;
    this.body = body;
    this.closure = closure;
    this.scope = scope;
    this.isUserFunction = true;
    this.properties = createDictionary();
    this.properties.prototype = createDictionary();
    this.lexicalThis = options.lexicalThis;
    this.expressionBody = options.expressionBody === true;
    this.bytecode = options.bytecode ?? null;
  }

  callFromInterpreter(interpreter, args, thisValue) {
    const local = interpreter.createScopeEnvironment(this.closure, this.scope);
    const resolvedThis = this.lexicalThis !== undefined ? this.lexicalThis : thisValue;

    if (this.scope.thisBinding) {
      local.initializeSlot(this.scope.thisBinding.slot, "const", resolvedThis);
    }

    if (this.scope.selfBinding) {
      local.initializeSlot(this.scope.selfBinding.slot, "const", this);
    }

    let argIndex = 0;
    for (let index = 0; index < this.params.length; index += 1) {
      const param = this.params[index];
      if (param.type === "RestElement") {
        interpreter.bindPattern(param, args.slice(argIndex), local, "var", "declare");
        argIndex = args.length;
        continue;
      }

      interpreter.bindPattern(
        param,
        argIndex < args.length ? args[argIndex] : undefined,
        local,
        "var",
        "declare"
      );
      argIndex += 1;
    }

    interpreter.initializeHoistedFunctions(local, this.scope);

    if (this.bytecode) {
      return interpreter.executeBytecode(this.bytecode, local);
    }

    try {
      if (this.expressionBody) {
        return interpreter.evaluateExpression(this.body, local);
      }

      interpreter.evaluateBlock(this.body, local, false);
    } catch (error) {
      if (error instanceof ReturnSignal) {
        return error.value;
      }
      throw error;
    }

    return undefined;
  }

  constructFromInterpreter(interpreter, args) {
    const prototype = this.properties.prototype && typeof this.properties.prototype === "object"
      ? this.properties.prototype
      : null;
    const instance = createDictionary(prototype);
    const result = this.callFromInterpreter(interpreter, args, instance);
    return result !== null && typeof result === "object" ? result : instance;
  }
}

export class Interpreter {
  constructor(outputLines = []) {
    this.outputLines = outputLines;
  }

  execute(program, globals = {}) {
    const env = this.createGlobalEnvironment(program, globals);

    try {
      if (program.bytecode) {
        this.initializeHoistedFunctions(env, program.scope);
        return this.executeBytecode(program.bytecode, env);
      }

      return this.evaluateProgram(program, env);
    } catch (error) {
      if (error instanceof ReturnSignal) {
        return error.value;
      }
      if (error instanceof BreakSignal || error instanceof ContinueSignal) {
        throw new JSLiteRuntimeError("Illegal loop control statement");
      }
      if (error instanceof ThrownSignal) {
        throw new JSLiteRuntimeError(toJsString(error.value));
      }
      throw error;
    }
  }

  createGlobalEnvironment(program, globals) {
    const env = new Environment(null, { scope: program.scope, type: program.scope.type });

    if (program.scope.thisBinding) {
      env.initializeSlot(program.scope.thisBinding.slot, "const", undefined);
    }

    env.predeclareVarSlots(program.scope.varSlots);

    const builtins = createBuiltins(this.outputLines);
    for (const binding of program.scope.builtinBindings ?? []) {
      env.initializeSlot(binding.slot, "const", builtins[binding.name]);
    }

    for (const [name, value] of Object.entries(globals)) {
      const binding = program.scope.bindingsByName.get(name);
      const hostValue = fromHostValue(value);
      if (binding) {
        env.declareHereResolved("let", binding.slot, name, hostValue, false);
      } else {
        env.declareHere("let", name, hostValue, false);
      }
    }

    return env;
  }

  executeBytecode(executable, env) {
    return executeBytecode(this, executable, env);
  }

  createScopeEnvironment(parent, scope) {
    const env = parent ? parent.createChildScope(scope) : new Environment(null, { scope, type: scope.type });
    env.predeclareVarSlots(scope.varSlots);
    return env;
  }

  initializeHoistedFunctions(env, scope) {
    for (const hoisted of scope.hoistedFunctions) {
      env.declareHereResolved("var", hoisted.slot, hoisted.node.id.name, this.createUserFunction(hoisted.node, env), true);
    }
  }

  evaluateProgram(program, env) {
    this.initializeHoistedFunctions(env, program.scope);
    let result = undefined;
    for (const statement of program.body) {
      const value = this.evaluateStatement(statement, env);
      if (value !== EMPTY) {
        result = unwrapOptional(value);
      }
    }
    return result;
  }

  evaluateBlock(block, env, createScope = true) {
    const scope = createScope ? this.createScopeEnvironment(env, block.scope) : env;
    let result = undefined;

    for (const statement of block.body) {
      const value = this.evaluateStatement(statement, scope);
      if (value !== EMPTY) {
        result = unwrapOptional(value);
      }
    }

    return result;
  }

  evaluateStatement(node, env) {
    switch (node.type) {
      case "EmptyStatement":
        return EMPTY;
      case "ExpressionStatement":
        return this.evaluateExpression(node.expression, env);
      case "VariableDeclaration":
        return this.evaluateVariableDeclaration(node, env);
      case "FunctionDeclaration":
        return this.evaluateFunctionDeclaration(node, env);
      case "BlockStatement":
        return this.evaluateBlock(node, env, true);
      case "IfStatement":
        return this.evaluateIfStatement(node, env);
      case "WhileStatement":
        return this.evaluateWhileStatement(node, env);
      case "ForStatement":
        return this.evaluateForStatement(node, env);
      case "ForInStatement":
        return this.evaluateForInStatement(node, env);
      case "ForOfStatement":
        return this.evaluateForOfStatement(node, env);
      case "DoWhileStatement":
        return this.evaluateDoWhileStatement(node, env);
      case "SwitchStatement":
        return this.evaluateSwitchStatement(node, env);
      case "ReturnStatement":
        throw new ReturnSignal(
          node.argument ? this.evaluateExpression(node.argument, env) : undefined
        );
      case "BreakStatement":
        throw new BreakSignal();
      case "ContinueStatement":
        throw new ContinueSignal();
      case "ThrowStatement":
        throw new ThrownSignal(this.evaluateExpression(node.argument, env));
      case "TryStatement":
        return this.evaluateTryStatement(node, env);
      default:
        throw new JSLiteRuntimeError(`Unsupported statement type '${node.type}'`);
    }
  }

  evaluateVariableDeclaration(node, env) {
    let result = undefined;
    for (const declaration of node.declarations) {
      result = declaration.init
        ? this.evaluateExpression(declaration.init, env)
        : undefined;
      this.bindPattern(declaration.id, result, env, node.kind, "declare");
    }
    return result;
  }

  evaluateFunctionDeclaration(node, env) {
    return node.id.binding ? env.lookupResolved(node.id.binding) : env.lookup(node.id.name);
  }

  evaluateIfStatement(node, env) {
    if (isTruthy(unwrapOptional(this.evaluateExpression(node.test, env)))) {
      return this.evaluateStatement(node.consequent, env);
    }

    if (node.alternate) {
      return this.evaluateStatement(node.alternate, env);
    }

    return EMPTY;
  }

  evaluateWhileStatement(node, env) {
    let result = undefined;

    while (isTruthy(unwrapOptional(this.evaluateExpression(node.test, env)))) {
      try {
        const iterationResult = this.evaluateStatement(node.body, env);
        if (iterationResult !== EMPTY) {
          result = iterationResult;
        }
      } catch (error) {
        if (error instanceof ContinueSignal) {
          continue;
        }
        if (error instanceof BreakSignal) {
          break;
        }
        throw error;
      }
    }

    return result;
  }

  evaluateDoWhileStatement(node, env) {
    let result = undefined;

    do {
      try {
        const iterationResult = this.evaluateStatement(node.body, env);
        if (iterationResult !== EMPTY) {
          result = iterationResult;
        }
      } catch (error) {
        if (error instanceof BreakSignal) {
          break;
        }
        if (!(error instanceof ContinueSignal)) {
          throw error;
        }
      }
    } while (isTruthy(unwrapOptional(this.evaluateExpression(node.test, env))));

    return result;
  }

  evaluateForStatement(node, env) {
    const loopEnv = this.createScopeEnvironment(env, node.scope);
    let result = undefined;

    if (node.init) {
      if (node.init.type === "VariableDeclaration") {
        this.evaluateVariableDeclaration(node.init, loopEnv);
      } else {
        this.evaluateExpression(node.init, loopEnv);
      }
    }

    while (
      node.test ? isTruthy(unwrapOptional(this.evaluateExpression(node.test, loopEnv))) : true
    ) {
      try {
        const iterationResult = this.evaluateStatement(node.body, loopEnv);
        if (iterationResult !== EMPTY) {
          result = iterationResult;
        }
      } catch (error) {
        if (error instanceof BreakSignal) {
          break;
        }
        if (!(error instanceof ContinueSignal)) {
          throw error;
        }
      }

      if (node.update) {
        this.evaluateExpression(node.update, loopEnv);
      }
    }

    return result;
  }

  evaluateForInStatement(node, env) {
    const loopEnv = this.createScopeEnvironment(env, node.scope);
    const target = this.evaluateExpression(node.right, loopEnv);
    let result = undefined;
    for (const key of Object.keys(target ?? {})) {
      this.assignLoopBinding(node.left, key, loopEnv);
      try {
        const iterationResult = this.evaluateStatement(node.body, loopEnv);
        if (iterationResult !== EMPTY) {
          result = iterationResult;
        }
      } catch (error) {
        if (error instanceof BreakSignal) {
          break;
        }
        if (!(error instanceof ContinueSignal)) {
          throw error;
        }
      }
    }
    return result;
  }

  evaluateForOfStatement(node, env) {
    const loopEnv = this.createScopeEnvironment(env, node.scope);
    const iterable = this.evaluateExpression(node.right, loopEnv);
    const values = typeof iterable === "string" ? Array.from(iterable) : Array.from(iterable ?? []);
    let result = undefined;
    for (const value of values) {
      this.assignLoopBinding(node.left, value, loopEnv);
      try {
        const iterationResult = this.evaluateStatement(node.body, loopEnv);
        if (iterationResult !== EMPTY) {
          result = iterationResult;
        }
      } catch (error) {
        if (error instanceof BreakSignal) {
          break;
        }
        if (!(error instanceof ContinueSignal)) {
          throw error;
        }
      }
    }
    return result;
  }

  evaluateSwitchStatement(node, env) {
    const discriminant = unwrapOptional(this.evaluateExpression(node.discriminant, env));
    let matched = false;
    let result = undefined;

    for (const switchCase of node.cases) {
      if (!matched) {
        matched = switchCase.test === null
          ? true
          : unwrapOptional(this.evaluateExpression(switchCase.test, env)) === discriminant;
      }

      if (!matched) {
        continue;
      }

      for (const statement of switchCase.consequent) {
        try {
          const value = this.evaluateStatement(statement, env);
          if (value !== EMPTY) {
            result = value;
          }
        } catch (error) {
          if (error instanceof BreakSignal) {
            return result;
          }
          throw error;
        }
      }
    }

    return result;
  }

  evaluateTryStatement(node, env) {
    let result = EMPTY;
    let pending = null;

    try {
      result = this.evaluateStatement(node.block, env);
    } catch (error) {
      if (error instanceof ThrownSignal && node.handler) {
        const catchEnv = this.createScopeEnvironment(env, node.handler.scope);
        if (node.handler.param) {
          catchEnv.declareResolved("let", node.handler.param.binding, error.value);
        }
        try {
          result = this.evaluateStatement(node.handler.body, catchEnv);
        } catch (catchError) {
          pending = catchError;
        }
      } else {
        pending = error;
      }
    }

    if (node.finalizer) {
      try {
        const finalResult = this.evaluateStatement(node.finalizer, env);
        if (finalResult !== EMPTY) {
          result = finalResult;
        }
      } catch (finalError) {
        pending = finalError;
      }
    }

    if (pending) {
      throw pending;
    }

    return result;
  }

  evaluateExpression(node, env) {
    switch (node.type) {
      case "Literal":
        return node.value;
      case "TemplateLiteral":
        return this.evaluateTemplateLiteral(node, env);
      case "RegExpLiteral":
        return new JSLiteRegExp(node.pattern, node.flags);
      case "Identifier":
        return node.resolution ? env.lookupResolved(node.resolution) : env.lookup(node.name);
      case "ThisExpression":
        return node.resolution ? env.lookupResolved(node.resolution) : env.lookup("this");
      case "ArrayExpression":
        return this.evaluateArrayExpression(node, env);
      case "ObjectExpression":
        return this.evaluateObjectExpression(node, env);
      case "UnaryExpression":
        return this.evaluateUnaryExpression(node, env);
      case "BinaryExpression":
        return this.evaluateBinaryExpression(node, env);
      case "LogicalExpression":
        return this.evaluateLogicalExpression(node, env);
      case "ConditionalExpression":
        return isTruthy(unwrapOptional(this.evaluateExpression(node.test, env)))
          ? this.evaluateExpression(node.consequent, env)
          : this.evaluateExpression(node.alternate, env);
      case "SequenceExpression":
        return this.evaluateSequenceExpression(node, env);
      case "AssignmentExpression":
        return this.evaluateAssignmentExpression(node, env);
      case "MemberExpression":
        return this.evaluateMemberExpression(node, env);
      case "CallExpression":
        return this.evaluateCallExpression(node, env);
      case "NewExpression":
        return this.evaluateNewExpression(node, env);
      case "FunctionExpression":
        return this.createUserFunction(node, env);
      case "ArrowFunctionExpression":
        return this.createUserFunction(node, env);
      case "UpdateExpression":
        return this.evaluateUpdateExpression(node, env);
      case "DeleteExpression":
        return this.evaluateDeleteExpression(node, env);
      default:
        throw new JSLiteRuntimeError(`Unsupported expression type '${node.type}'`);
    }
  }

  evaluateObjectExpression(node, env) {
    const result = createDictionary();
    for (const property of node.properties) {
      const key = property.computed
        ? this.evaluateExpression(property.key, env)
        : property.key;
      result[String(key)] = this.evaluateExpression(property.value, env);
    }
    return result;
  }

  evaluateTemplateLiteral(node, env) {
    let result = "";
    for (let index = 0; index < node.quasis.length; index += 1) {
      result += node.quasis[index];
      if (index < node.expressions.length) {
        result += toJsString(unwrapOptional(this.evaluateExpression(node.expressions[index], env)));
      }
    }
    return result;
  }

  evaluateArrayExpression(node, env) {
    const result = [];
    for (const element of node.elements) {
      if (element?.type === "SpreadElement") {
        result.push(...this.expandSpreadValue(this.evaluateExpression(element.argument, env)));
      } else {
        result.push(this.evaluateExpression(element, env));
      }
    }
    return result;
  }

  evaluateUnaryExpression(node, env) {
    if (node.operator === "typeof") {
      if (
        node.argument.type === "Identifier" &&
        !(node.argument.resolution ? env.hasResolved(node.argument.resolution) : env.has(node.argument.name))
      ) {
        return "undefined";
      }
      return typeOf(unwrapOptional(this.evaluateExpression(node.argument, env)));
    }

    const value = unwrapOptional(this.evaluateExpression(node.argument, env));

    switch (node.operator) {
      case "!":
        return !isTruthy(value);
      case "-":
        return -toJsNumber(value);
      case "+":
        return toJsNumber(value);
      case "~":
        return ~Math.trunc(toJsNumber(value));
      case "void":
        return undefined;
      case "delete":
        if (node.argument.type === "MemberExpression") {
          const target = this.evaluateExpression(node.argument.object, env);
          const property = node.argument.computed
            ? this.evaluateExpression(node.argument.property, env)
            : node.argument.property.name;
          return deleteProperty(target, property);
        }
        return true;
      default:
        throw new JSLiteRuntimeError(`Unsupported unary operator '${node.operator}'`);
    }
  }

  evaluateBinaryExpression(node, env) {
    const left = unwrapOptional(this.evaluateExpression(node.left, env));
    const right = unwrapOptional(this.evaluateExpression(node.right, env));

    switch (node.operator) {
      case "+":
        return addValues(left, right);
      case "-":
        return toJsNumber(left) - toJsNumber(right);
      case "*":
        return toJsNumber(left) * toJsNumber(right);
      case "/":
        return toJsNumber(left) / toJsNumber(right);
      case "%":
        return toJsNumber(left) % toJsNumber(right);
      case "**":
        return toJsNumber(left) ** toJsNumber(right);
      case "==":
        return left == right; // eslint-disable-line eqeqeq
      case "!=":
        return left != right; // eslint-disable-line eqeqeq
      case "===":
        return left === right;
      case "!==":
        return left !== right;
      case "<":
        return compareRelationalValues(left, right, "<");
      case "<=":
        return compareRelationalValues(left, right, "<=");
      case ">":
        return compareRelationalValues(left, right, ">");
      case ">=":
        return compareRelationalValues(left, right, ">=");
      case "&":
        return Math.trunc(toJsNumber(left)) & Math.trunc(toJsNumber(right));
      case "|":
        return Math.trunc(toJsNumber(left)) | Math.trunc(toJsNumber(right));
      case "^":
        return Math.trunc(toJsNumber(left)) ^ Math.trunc(toJsNumber(right));
      case "<<":
        return Math.trunc(toJsNumber(left)) << (Math.trunc(toJsNumber(right)) & 0x1f);
      case ">>":
        return Math.trunc(toJsNumber(left)) >> (Math.trunc(toJsNumber(right)) & 0x1f);
      case ">>>":
        return Math.trunc(toJsNumber(left)) >>> (Math.trunc(toJsNumber(right)) & 0x1f);
      case "in":
        return hasProperty(right, left);
      case "instanceof":
        return instanceOfValue(left, right);
      default:
        throw new JSLiteRuntimeError(`Unsupported binary operator '${node.operator}'`);
    }
  }

  evaluateLogicalExpression(node, env) {
    const left = unwrapOptional(this.evaluateExpression(node.left, env));

    switch (node.operator) {
      case "&&":
        return isTruthy(left) ? unwrapOptional(this.evaluateExpression(node.right, env)) : left;
      case "||":
        return isTruthy(left) ? left : unwrapOptional(this.evaluateExpression(node.right, env));
      case "??":
        return isNullish(left)
          ? unwrapOptional(this.evaluateExpression(node.right, env))
          : left;
      default:
        throw new JSLiteRuntimeError(`Unsupported logical operator '${node.operator}'`);
    }
  }

  evaluateSequenceExpression(node, env) {
    let result = undefined;
    for (const expression of node.expressions) {
      result = unwrapOptional(this.evaluateExpression(expression, env));
    }
    return result;
  }

  evaluateAssignmentExpression(node, env) {
    if (node.left.type === "Identifier") {
      const current = node.left.resolution
        ? env.lookupResolved(node.left.resolution)
        : env.lookup(node.left.name);
      const right = unwrapOptional(this.evaluateExpression(node.right, env));
      const next = applyAssignmentOperator(node.operator, current, right);
      if (node.left.resolution) {
        env.assignResolved(node.left.resolution, next);
      } else {
        env.assign(node.left.name, next);
      }
      return next;
    }

    const target = this.evaluateExpression(node.left.object, env);
    const property = node.left.computed
      ? this.evaluateExpression(node.left.property, env)
      : node.left.property.name;
    const current = safeGet(unwrapOptional(target), property);
    const right = unwrapOptional(this.evaluateExpression(node.right, env));
    const next = applyAssignmentOperator(node.operator, current, right);
    safeSet(unwrapOptional(target), property, next);
    return next;
  }

  evaluateMemberExpression(node, env) {
    const object = this.evaluateExpression(node.object, env);
    if (object === OPTIONAL_CHAIN_NULL) {
      return node.chain ? OPTIONAL_CHAIN_NULL : null;
    }

    if (node.optional && isNullish(object)) {
      return OPTIONAL_CHAIN_NULL;
    }

    const property = node.computed
      ? this.evaluateExpression(node.property, env)
      : node.property.name;
    return safeGet(unwrapOptional(object), unwrapOptional(property));
  }

  evaluateCallExpression(node, env) {
    if (node.callee.type === "MemberExpression") {
      const target = this.evaluateExpression(node.callee.object, env);
      if (target === OPTIONAL_CHAIN_NULL) {
        return node.chain ? OPTIONAL_CHAIN_NULL : null;
      }

      if (node.callee.optional && isNullish(target)) {
        return OPTIONAL_CHAIN_NULL;
      }

      const property = node.callee.computed
        ? this.evaluateExpression(node.callee.property, env)
        : node.callee.property.name;
      const callee = safeGet(unwrapOptional(target), unwrapOptional(property));
      if (node.optional && isNullish(callee)) {
        return OPTIONAL_CHAIN_NULL;
      }
      const args = this.evaluateArgumentList(node.arguments, env);
      return callFunction(callee, args, unwrapOptional(target), this);
    }

    const callee = this.evaluateExpression(node.callee, env);
    if (callee === OPTIONAL_CHAIN_NULL) {
      return node.chain ? OPTIONAL_CHAIN_NULL : null;
    }

    if (node.optional && isNullish(callee)) {
      return OPTIONAL_CHAIN_NULL;
    }

    const args = this.evaluateArgumentList(node.arguments, env);
    return callFunction(unwrapOptional(callee), args, undefined, this);
  }

  evaluateNewExpression(node, env) {
    const callee = unwrapOptional(this.evaluateExpression(node.callee, env));
    const args = this.evaluateArgumentList(node.arguments, env);
    return constructValue(callee, args, this);
  }

  evaluateUpdateExpression(node, env) {
    if (node.argument.type === "Identifier") {
      const current = node.argument.resolution
        ? env.lookupResolved(node.argument.resolution)
        : env.lookup(node.argument.name);
      const next = node.operator === "++" ? toJsNumber(current) + 1 : toJsNumber(current) - 1;
      if (node.argument.resolution) {
        env.assignResolved(node.argument.resolution, next);
      } else {
        env.assign(node.argument.name, next);
      }
      return node.prefix ? next : current;
    }

    const target = this.evaluateExpression(node.argument.object, env);
    const property = node.argument.computed
      ? this.evaluateExpression(node.argument.property, env)
      : node.argument.property.name;
    const current = safeGet(target, property);
    const next = node.operator === "++" ? toJsNumber(current) + 1 : toJsNumber(current) - 1;
    safeSet(target, property, next);
    return node.prefix ? next : current;
  }

  evaluateDeleteExpression(node, env) {
    if (node.argument.type === "MemberExpression") {
      const target = this.evaluateExpression(node.argument.object, env);
      const property = node.argument.computed
        ? this.evaluateExpression(node.argument.property, env)
        : node.argument.property.name;
      return deleteProperty(target, property);
    }

    return true;
  }

  evaluateArgumentList(argumentsList, env) {
    const args = [];
    for (const arg of argumentsList) {
      if (arg?.type === "SpreadElement") {
        args.push(...this.expandSpreadValue(unwrapOptional(this.evaluateExpression(arg.argument, env))));
      } else {
        args.push(unwrapOptional(this.evaluateExpression(arg, env)));
      }
    }
    return args;
  }

  expandSpreadValue(value) {
    if (Array.isArray(value)) {
      return value;
    }

    if (typeof value === "string") {
      return Array.from(value);
    }

    return Array.from(value ?? []);
  }

  assignLoopBinding(left, value, env) {
    if (left.type === "VariableDeclaration") {
      const declaration = left.declarations[0];
      this.bindPattern(declaration.id, value, env, left.kind, "loop");
      return;
    }

    if (left.type === "Identifier" || left.type === "ArrayPattern" || left.type === "ObjectPattern") {
      this.bindPattern(left, value, env, "let", "assign");
      return;
    }

    throw new JSLiteRuntimeError("Unsupported loop binding");
  }

  bindPattern(pattern, value, env, kind, mode) {
    switch (pattern.type) {
      case "Identifier":
        return this.writeBinding(pattern, value, env, kind, mode);
      case "AssignmentPattern": {
        const nextValue = value === undefined
          ? this.evaluateExpression(pattern.right, env)
          : value;
        return this.bindPattern(pattern.left, nextValue, env, kind, mode);
      }
      case "RestElement":
        return this.bindPattern(pattern.argument, value, env, kind, mode);
      case "ArrayPattern": {
        const entries = Array.isArray(value)
          ? value
          : (typeof value === "string" ? Array.from(value) : Array.from(value ?? []));

        for (let index = 0; index < pattern.elements.length; index += 1) {
          const element = pattern.elements[index];
          if (!element) {
            continue;
          }

          if (element.type === "RestElement") {
            this.bindPattern(element.argument, entries.slice(index), env, kind, mode);
            break;
          }

          this.bindPattern(
            element,
            index < entries.length ? entries[index] : undefined,
            env,
            kind,
            mode
          );
        }

        return value;
      }
      case "ObjectPattern": {
        const source = value !== null && typeof value === "object"
          ? value
          : createDictionary();

        for (const property of pattern.properties) {
          const key = property.computed
            ? this.evaluateExpression(property.key, env)
            : property.key;
          const propertyValue = safeGet(source, key);
          this.bindPattern(property.value, propertyValue, env, kind, mode);
        }

        return value;
      }
      default:
        throw new JSLiteRuntimeError(`Unsupported binding pattern '${pattern.type}'`);
    }
  }

  writeBinding(identifier, value, env, kind, mode) {
    const resolution = identifier.binding ?? identifier.resolution ?? null;
    const name = identifier.name;

    switch (mode) {
      case "declare":
        return resolution
          ? env.declareResolved(kind, resolution, value)
          : env.declare(kind, name, value);
      case "assign":
        return resolution
          ? env.assignResolved(resolution, value)
          : env.assign(name, value);
      case "declareOrAssign":
        if (resolution) {
          return env.hasResolved(resolution)
            ? env.assignResolved(resolution, value)
            : env.declareResolved(kind, resolution, value);
        }
        return env.has(name)
          ? env.assign(name, value)
          : env.declare(kind, name, value);
      case "loop":
        if (kind === "var") {
          if (resolution) {
            return env.hasResolved(resolution)
              ? env.assignResolved(resolution, value)
              : env.declareResolved(kind, resolution, value);
          }
          return env.has(name)
            ? env.assign(name, value)
            : env.declare(kind, name, value);
        }
        return resolution
          ? env.redeclareResolved(kind, resolution, value)
          : env.redeclare(name, kind, value);
      default:
        throw new JSLiteRuntimeError(`Unsupported binding mode '${mode}'`);
    }
  }

  createUserFunction(node, env) {
    const options = {
      bytecode: node.bytecode ?? null,
    };

    if (node.type === "ArrowFunctionExpression") {
      options.lexicalThis = env.has("this") ? env.lookup("this") : undefined;
      options.expressionBody = node.expression;
    }

    return new UserFunction(node.id?.name ?? null, node.params, node.body, env, node.scope, options);
  }
}

function applyAssignmentOperator(operator, current, right) {
  switch (operator) {
    case "=":
      return right;
    case "+=":
      return addValues(current, right);
    case "-=":
      return toJsNumber(current) - toJsNumber(right);
    case "*=":
      return toJsNumber(current) * toJsNumber(right);
    case "/=":
      return toJsNumber(current) / toJsNumber(right);
    case "%=":
      return toJsNumber(current) % toJsNumber(right);
    case "**=":
      return toJsNumber(current) ** toJsNumber(right);
    case "??=":
      return isNullish(current) ? right : current;
    case "&=":
      return Math.trunc(toJsNumber(current)) & Math.trunc(toJsNumber(right));
    case "|=":
      return Math.trunc(toJsNumber(current)) | Math.trunc(toJsNumber(right));
    case "^=":
      return Math.trunc(toJsNumber(current)) ^ Math.trunc(toJsNumber(right));
    case "<<=":
      return Math.trunc(toJsNumber(current)) << (Math.trunc(toJsNumber(right)) & 0x1f);
    case ">>=":
      return Math.trunc(toJsNumber(current)) >> (Math.trunc(toJsNumber(right)) & 0x1f);
    case ">>>=":
      return Math.trunc(toJsNumber(current)) >>> (Math.trunc(toJsNumber(right)) & 0x1f);
    default:
      throw new JSLiteRuntimeError(`Unsupported assignment operator '${operator}'`);
  }
}

function addValues(left, right) {
  const normalizedLeft = normalizeAddOperand(left);
  const normalizedRight = normalizeAddOperand(right);

  if (typeof normalizedLeft === "string" || typeof normalizedRight === "string") {
    return toJsString(normalizedLeft) + toJsString(normalizedRight);
  }

  return toJsNumber(normalizedLeft) + toJsNumber(normalizedRight);
}

function normalizeAddOperand(value) {
  if (value !== null && typeof value === "object") {
    return toJsString(value);
  }

  return value;
}

const EMPTY = Symbol("empty");
const OPTIONAL_CHAIN_NULL = Symbol("optional-chain-null");

function unwrapOptional(value) {
  return value === OPTIONAL_CHAIN_NULL ? null : value;
}

export { UserFunction };
