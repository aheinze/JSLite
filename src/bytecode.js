import { JSLiteRuntimeError } from "./errors.js";
import {
  callFunction,
  compareRelationalValues,
  constructValue,
  createDictionary,
  deleteProperty,
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
import { ThrownSignal } from "./signals.js";

const OP = {
  PUSH_CONST: 0,
  PUSH_REGEX: 1,
  LOAD_RESOLVED: 2,
  LOAD_NAME: 3,
  TYPEOF_RESOLVED: 4,
  TYPEOF_NAME: 5,
  DECLARE_RESOLVED: 6,
  DECLARE_NAME: 7,
  STORE_RESOLVED: 8,
  STORE_NAME: 9,
  ASSIGN_RESOLVED: 10,
  ASSIGN_NAME: 11,
  ASSIGN_MEMBER_NAMED: 12,
  ASSIGN_MEMBER_COMPUTED: 13,
  UPDATE_RESOLVED: 14,
  UPDATE_NAME: 15,
  UPDATE_MEMBER_NAMED: 16,
  UPDATE_MEMBER_COMPUTED: 17,
  DELETE_MEMBER_NAMED: 18,
  DELETE_MEMBER_COMPUTED: 19,
  DUP: 20,
  POP: 21,
  UNARY: 22,
  BINARY: 23,
  JUMP: 24,
  JUMP_IF_FALSE: 25,
  JUMP_IF_FALSE_KEEP: 26,
  JUMP_IF_TRUE_KEEP: 27,
  JUMP_IF_NOT_NULLISH_KEEP: 28,
  ENTER_SCOPE: 29,
  EXIT_SCOPE: 30,
  UNWIND: 31,
  PUSH_RESULT_SLOT: 32,
  POP_RESULT_SLOT: 33,
  SET_RESULT: 34,
  RETURN: 35,
  RETURN_UNDEFINED: 36,
  RETURN_RESULT: 37,
  MAKE_ARRAY: 38,
  MAKE_OBJECT: 39,
  GET_MEMBER_NAMED: 40,
  GET_MEMBER_COMPUTED: 41,
  CALL: 42,
  CALL_MEMBER_NAMED: 43,
  CALL_MEMBER_COMPUTED: 44,
  MAKE_FUNCTION: 45,
  CONSTRUCT: 46,
  STORE_TEMP: 47,
  LOAD_TEMP: 48,
  PUSH_THROW_HANDLER: 49,
  POP_THROW_HANDLER: 50,
  THROW: 51,
  BIND_PATTERN: 52,
  ENUM_KEYS: 53,
  ITER_VALUES: 54,
  CALL_WITH_THIS: 55,
  MAKE_ARRAY_SPREAD: 56,
  CALL_SPREAD: 57,
  CALL_MEMBER_NAMED_SPREAD: 58,
  CALL_MEMBER_COMPUTED_SPREAD: 59,
  CONSTRUCT_SPREAD: 60,
  CALL_WITH_THIS_SPREAD: 61,
};

const COMPUTED = Symbol("computed");

export function attachBytecode(program) {
  visitStatements(program.body);
  program.bytecode = compileProgramExecutable(program);
  return program;
}

export function executeBytecode(interpreter, executable, env) {
  const instructions = executable.instructions;
  const stack = [];
  const resultStack = [undefined];
  const temps = [];
  const throwHandlers = [];
  let currentEnv = env;
  let ip = 0;
  let scopeDepth = 0;
  let resultDepth = 1;

  while (ip < instructions.length) {
    const instruction = instructions[ip];
    const opcode = instruction[0];

    try {
      switch (opcode) {
        case OP.PUSH_CONST:
          stack.push(instruction[1]);
          ip += 1;
          break;
        case OP.PUSH_REGEX:
          stack.push(new JSLiteRegExp(instruction[1], instruction[2]));
          ip += 1;
          break;
        case OP.LOAD_RESOLVED:
          stack.push(currentEnv.lookupResolved(instruction[1]));
          ip += 1;
          break;
        case OP.LOAD_NAME:
          stack.push(currentEnv.lookup(instruction[1]));
          ip += 1;
          break;
        case OP.TYPEOF_RESOLVED:
          stack.push(
            currentEnv.hasResolved(instruction[1])
              ? typeOf(currentEnv.lookupResolved(instruction[1]))
              : "undefined"
          );
          ip += 1;
          break;
        case OP.TYPEOF_NAME:
          stack.push(
            currentEnv.has(instruction[1])
              ? typeOf(currentEnv.lookup(instruction[1]))
              : "undefined"
          );
          ip += 1;
          break;
        case OP.DECLARE_RESOLVED: {
          const value = stack.pop();
          currentEnv.declareResolved(instruction[1], instruction[2], value);
          ip += 1;
          break;
        }
        case OP.DECLARE_NAME: {
          const value = stack.pop();
          currentEnv.declare(instruction[1], instruction[2], value);
          ip += 1;
          break;
        }
        case OP.STORE_RESOLVED: {
          const value = stack.pop();
          currentEnv.assignResolved(instruction[1], value);
          ip += 1;
          break;
        }
        case OP.STORE_NAME: {
          const value = stack.pop();
          currentEnv.assign(instruction[1], value);
          ip += 1;
          break;
        }
        case OP.ASSIGN_RESOLVED: {
          const right = stack.pop();
          const operator = instruction[1];
          const resolution = instruction[2];
          const current = operator === "=" ? undefined : currentEnv.lookupResolved(resolution);
          const next = applyAssignmentOperator(operator, current, right);
          currentEnv.assignResolved(resolution, next);
          stack.push(next);
          ip += 1;
          break;
        }
        case OP.ASSIGN_NAME: {
          const right = stack.pop();
          const operator = instruction[1];
          const name = instruction[2];
          const current = operator === "=" ? undefined : currentEnv.lookup(name);
          const next = applyAssignmentOperator(operator, current, right);
          currentEnv.assign(name, next);
          stack.push(next);
          ip += 1;
          break;
        }
        case OP.ASSIGN_MEMBER_NAMED: {
          const right = stack.pop();
          const target = stack.pop();
          const operator = instruction[1];
          const property = instruction[2];
          const current = operator === "=" ? undefined : safeGet(target, property);
          const next = applyAssignmentOperator(operator, current, right);
          safeSet(target, property, next);
          stack.push(next);
          ip += 1;
          break;
        }
        case OP.ASSIGN_MEMBER_COMPUTED: {
          const right = stack.pop();
          const property = stack.pop();
          const target = stack.pop();
          const operator = instruction[1];
          const current = operator === "=" ? undefined : safeGet(target, property);
          const next = applyAssignmentOperator(operator, current, right);
          safeSet(target, property, next);
          stack.push(next);
          ip += 1;
          break;
        }
        case OP.UPDATE_RESOLVED: {
          const resolution = instruction[1];
          const operator = instruction[2];
          const prefix = instruction[3];
          const current = currentEnv.lookupResolved(resolution);
          const next = operator === "++" ? toJsNumber(current) + 1 : toJsNumber(current) - 1;
          currentEnv.assignResolved(resolution, next);
          stack.push(prefix ? next : current);
          ip += 1;
          break;
        }
        case OP.UPDATE_NAME: {
          const name = instruction[1];
          const operator = instruction[2];
          const prefix = instruction[3];
          const current = currentEnv.lookup(name);
          const next = operator === "++" ? toJsNumber(current) + 1 : toJsNumber(current) - 1;
          currentEnv.assign(name, next);
          stack.push(prefix ? next : current);
          ip += 1;
          break;
        }
        case OP.UPDATE_MEMBER_NAMED: {
          const target = stack.pop();
          const property = instruction[1];
          const operator = instruction[2];
          const prefix = instruction[3];
          const current = safeGet(target, property);
          const next = operator === "++" ? toJsNumber(current) + 1 : toJsNumber(current) - 1;
          safeSet(target, property, next);
          stack.push(prefix ? next : current);
          ip += 1;
          break;
        }
        case OP.UPDATE_MEMBER_COMPUTED: {
          const property = stack.pop();
          const target = stack.pop();
          const operator = instruction[1];
          const prefix = instruction[2];
          const current = safeGet(target, property);
          const next = operator === "++" ? toJsNumber(current) + 1 : toJsNumber(current) - 1;
          safeSet(target, property, next);
          stack.push(prefix ? next : current);
          ip += 1;
          break;
        }
        case OP.DELETE_MEMBER_NAMED:
          stack.push(deleteProperty(stack.pop(), instruction[1]));
          ip += 1;
          break;
        case OP.DELETE_MEMBER_COMPUTED: {
          const property = stack.pop();
          const target = stack.pop();
          stack.push(deleteProperty(target, property));
          ip += 1;
          break;
        }
        case OP.DUP:
          stack.push(stack[stack.length - 1]);
          ip += 1;
          break;
        case OP.POP:
          stack.pop();
          ip += 1;
          break;
        case OP.UNARY: {
          const operator = instruction[1];
          const value = stack.pop();
          stack.push(applyUnaryOperator(operator, value));
          ip += 1;
          break;
        }
        case OP.BINARY: {
          const right = stack.pop();
          const left = stack.pop();
          stack.push(applyBinaryOperator(instruction[1], left, right));
          ip += 1;
          break;
        }
        case OP.JUMP:
          ip = instruction[1];
          break;
        case OP.JUMP_IF_FALSE: {
          const value = stack.pop();
          ip = isTruthy(value) ? ip + 1 : instruction[1];
          break;
        }
        case OP.JUMP_IF_FALSE_KEEP:
          ip = isTruthy(stack[stack.length - 1]) ? ip + 1 : instruction[1];
          break;
        case OP.JUMP_IF_TRUE_KEEP:
          ip = isTruthy(stack[stack.length - 1]) ? instruction[1] : ip + 1;
          break;
        case OP.JUMP_IF_NOT_NULLISH_KEEP:
          ip = isNullish(stack[stack.length - 1]) ? ip + 1 : instruction[1];
          break;
        case OP.ENTER_SCOPE:
          currentEnv = interpreter.createScopeEnvironment(currentEnv, instruction[1]);
          interpreter.initializeHoistedFunctions(currentEnv, instruction[1]);
          scopeDepth += 1;
          ip += 1;
          break;
        case OP.EXIT_SCOPE:
          currentEnv = currentEnv.parent;
          scopeDepth -= 1;
          ip += 1;
          break;
        case OP.UNWIND:
          currentEnv = unwindScopes(currentEnv, instruction[1]);
          scopeDepth -= instruction[1];
          resultStack.length -= instruction[2];
          resultDepth -= instruction[2];
          ip += 1;
          break;
        case OP.PUSH_RESULT_SLOT:
          resultStack.push(undefined);
          resultDepth += 1;
          ip += 1;
          break;
        case OP.POP_RESULT_SLOT:
          stack.push(resultStack.pop());
          resultDepth -= 1;
          ip += 1;
          break;
        case OP.SET_RESULT:
          resultStack[resultStack.length - 1] = stack.pop();
          ip += 1;
          break;
        case OP.RETURN:
          return stack.pop();
        case OP.RETURN_UNDEFINED:
          return undefined;
        case OP.RETURN_RESULT:
          return resultStack[resultStack.length - 1];
        case OP.MAKE_ARRAY: {
          const count = instruction[1];
          const result = new Array(count);
          for (let index = count - 1; index >= 0; index -= 1) {
            result[index] = stack.pop();
          }
          stack.push(result);
          ip += 1;
          break;
        }
        case OP.MAKE_ARRAY_SPREAD: {
          const flags = instruction[1];
          const count = flags.length;
          const items = new Array(count);
          for (let index = count - 1; index >= 0; index -= 1) {
            items[index] = stack.pop();
          }
          const result = [];
          for (let index = 0; index < count; index += 1) {
            if (flags[index]) {
              const v = items[index];
              if (Array.isArray(v)) {
                result.push(...v);
              } else if (typeof v === "string") {
                result.push(...Array.from(v));
              } else {
                result.push(...Array.from(v ?? []));
              }
            } else {
              result.push(items[index]);
            }
          }
          stack.push(result);
          ip += 1;
          break;
        }
        case OP.MAKE_OBJECT: {
          const descriptors = instruction[1];
          const result = createDictionary();
          const entries = new Array(descriptors.length);
          for (let index = descriptors.length - 1; index >= 0; index -= 1) {
            const descriptor = descriptors[index];
            const value = stack.pop();
            const key = descriptor === COMPUTED ? stack.pop() : descriptor;
            entries[index] = [key, value];
          }
          for (const [key, value] of entries) {
            result[String(key)] = value;
          }
          stack.push(result);
          ip += 1;
          break;
        }
        case OP.GET_MEMBER_NAMED:
          stack.push(safeGet(stack.pop(), instruction[1]));
          ip += 1;
          break;
        case OP.GET_MEMBER_COMPUTED: {
          const property = stack.pop();
          const target = stack.pop();
          stack.push(safeGet(target, property));
          ip += 1;
          break;
        }
        case OP.CALL: {
          const args = popArgs(stack, instruction[1]);
          const callee = stack.pop();
          stack.push(callFunction(callee, args, undefined, interpreter));
          ip += 1;
          break;
        }
        case OP.CALL_WITH_THIS: {
          const args = popArgs(stack, instruction[1]);
          const thisValue = stack.pop();
          const callee = stack.pop();
          stack.push(callFunction(callee, args, thisValue, interpreter));
          ip += 1;
          break;
        }
        case OP.CALL_MEMBER_NAMED: {
          const args = popArgs(stack, instruction[2]);
          const target = stack.pop();
          const callee = safeGet(target, instruction[1]);
          stack.push(callFunction(callee, args, target, interpreter));
          ip += 1;
          break;
        }
        case OP.CALL_MEMBER_COMPUTED: {
          const args = popArgs(stack, instruction[1]);
          const property = stack.pop();
          const target = stack.pop();
          const callee = safeGet(target, property);
          stack.push(callFunction(callee, args, target, interpreter));
          ip += 1;
          break;
        }
        case OP.MAKE_FUNCTION:
          stack.push(interpreter.createUserFunction(instruction[1], currentEnv));
          ip += 1;
          break;
        case OP.CONSTRUCT: {
          const args = popArgs(stack, instruction[1]);
          const callee = stack.pop();
          stack.push(constructValue(callee, args, interpreter));
          ip += 1;
          break;
        }
        case OP.CALL_SPREAD: {
          const args = popSpreadArgs(stack, instruction[1]);
          const callee = stack.pop();
          stack.push(callFunction(callee, args, undefined, interpreter));
          ip += 1;
          break;
        }
        case OP.CALL_WITH_THIS_SPREAD: {
          const args = popSpreadArgs(stack, instruction[1]);
          const thisValue = stack.pop();
          const callee = stack.pop();
          stack.push(callFunction(callee, args, thisValue, interpreter));
          ip += 1;
          break;
        }
        case OP.CALL_MEMBER_NAMED_SPREAD: {
          const args = popSpreadArgs(stack, instruction[2]);
          const target = stack.pop();
          const callee = safeGet(target, instruction[1]);
          stack.push(callFunction(callee, args, target, interpreter));
          ip += 1;
          break;
        }
        case OP.CALL_MEMBER_COMPUTED_SPREAD: {
          const args = popSpreadArgs(stack, instruction[1]);
          const property = stack.pop();
          const target = stack.pop();
          const callee = safeGet(target, property);
          stack.push(callFunction(callee, args, target, interpreter));
          ip += 1;
          break;
        }
        case OP.CONSTRUCT_SPREAD: {
          const args = popSpreadArgs(stack, instruction[1]);
          const callee = stack.pop();
          stack.push(constructValue(callee, args, interpreter));
          ip += 1;
          break;
        }
        case OP.STORE_TEMP:
          temps[instruction[1]] = stack.pop();
          ip += 1;
          break;
        case OP.LOAD_TEMP:
          stack.push(temps[instruction[1]]);
          ip += 1;
          break;
        case OP.PUSH_THROW_HANDLER:
          throwHandlers.push({
            target: instruction[1],
            temp: instruction[2],
            scopeDepth: instruction[3],
            resultDepth: instruction[4],
          });
          ip += 1;
          break;
        case OP.POP_THROW_HANDLER:
          throwHandlers.pop();
          ip += 1;
          break;
        case OP.THROW:
          throw new ThrownSignal(stack.pop());
        case OP.BIND_PATTERN: {
          const value = stack.pop();
          interpreter.bindPattern(instruction[1], value, currentEnv, instruction[2], instruction[3]);
          ip += 1;
          break;
        }
        case OP.ENUM_KEYS:
          stack.push(Object.keys(stack.pop() ?? {}));
          ip += 1;
          break;
        case OP.ITER_VALUES: {
          const iterable = stack.pop();
          stack.push(
            typeof iterable === "string"
              ? Array.from(iterable)
              : Array.from(iterable ?? [])
          );
          ip += 1;
          break;
        }
        default:
          throw new JSLiteRuntimeError(`Unsupported bytecode opcode '${opcode}'`);
      }
    } catch (error) {
      if (!(error instanceof ThrownSignal)) {
        throw error;
      }

      const handler = throwHandlers.pop();
      if (!handler) {
        throw error;
      }

      if (scopeDepth > handler.scopeDepth) {
        currentEnv = unwindScopes(currentEnv, scopeDepth - handler.scopeDepth);
      }
      scopeDepth = handler.scopeDepth;

      if (resultDepth > handler.resultDepth) {
        resultStack.length -= resultDepth - handler.resultDepth;
      }
      resultDepth = handler.resultDepth;

      temps[handler.temp] = error.value;
      ip = handler.target;
      stack.length = 0;
    }
  }

  return executable.implicitReturnResult === true
    ? resultStack[resultStack.length - 1]
    : undefined;
}

function visitStatements(statements) {
  for (const statement of statements) {
    visitStatement(statement);
  }
}

function visitStatement(node) {
  switch (node.type) {
    case "ExpressionStatement":
      visitExpression(node.expression);
      return;
    case "VariableDeclaration":
      for (const declaration of node.declarations) {
        if (declaration.init) {
          visitExpression(declaration.init);
        }
      }
      return;
    case "FunctionDeclaration":
      attachFunctionBytecode(node);
      visitStatements(node.body.body);
      return;
    case "BlockStatement":
      visitStatements(node.body);
      return;
    case "IfStatement":
      visitExpression(node.test);
      visitStatement(node.consequent);
      if (node.alternate) {
        visitStatement(node.alternate);
      }
      return;
    case "WhileStatement":
    case "DoWhileStatement":
      visitExpression(node.test);
      visitStatement(node.body);
      return;
    case "ForStatement":
      if (node.init) {
        if (node.init.type === "VariableDeclaration") {
          visitStatement(node.init);
        } else {
          visitExpression(node.init);
        }
      }
      if (node.test) {
        visitExpression(node.test);
      }
      if (node.update) {
        visitExpression(node.update);
      }
      visitStatement(node.body);
      return;
    case "ForInStatement":
    case "ForOfStatement":
      if (node.left.type !== "VariableDeclaration") {
        visitExpression(node.left);
      }
      visitExpression(node.right);
      visitStatement(node.body);
      return;
    case "SwitchStatement":
      visitExpression(node.discriminant);
      for (const switchCase of node.cases) {
        if (switchCase.test) {
          visitExpression(switchCase.test);
        }
        visitStatements(switchCase.consequent);
      }
      return;
    case "ReturnStatement":
    case "ThrowStatement":
      if (node.argument) {
        visitExpression(node.argument);
      }
      return;
    case "TryStatement":
      visitStatement(node.block);
      if (node.handler?.param) {
        visitExpression(node.handler.param);
      }
      if (node.handler?.body) {
        visitStatement(node.handler.body);
      }
      if (node.finalizer) {
        visitStatement(node.finalizer);
      }
      return;
    default:
      return;
  }
}

function visitExpression(node) {
  if (!node) {
    return;
  }

  switch (node.type) {
    case "TemplateLiteral":
      for (const expression of node.expressions) {
        visitExpression(expression);
      }
      return;
    case "ArrayExpression":
      for (const element of node.elements) {
        if (!element) {
          continue;
        }
        if (element.type === "SpreadElement") {
          visitExpression(element.argument);
        } else {
          visitExpression(element);
        }
      }
      return;
    case "ObjectExpression":
      for (const property of node.properties) {
        if (property.computed) {
          visitExpression(property.key);
        }
        visitExpression(property.value);
      }
      return;
    case "UnaryExpression":
    case "UpdateExpression":
      visitExpression(node.argument);
      return;
    case "BinaryExpression":
    case "LogicalExpression":
      visitExpression(node.left);
      visitExpression(node.right);
      return;
    case "ConditionalExpression":
      visitExpression(node.test);
      visitExpression(node.consequent);
      visitExpression(node.alternate);
      return;
    case "SequenceExpression":
      for (const expression of node.expressions) {
        visitExpression(expression);
      }
      return;
    case "AssignmentExpression":
      visitExpression(node.left);
      visitExpression(node.right);
      return;
    case "MemberExpression":
      visitExpression(node.object);
      if (node.computed) {
        visitExpression(node.property);
      }
      return;
    case "CallExpression":
    case "NewExpression":
      visitExpression(node.callee);
      for (const arg of node.arguments) {
        if (arg.type === "SpreadElement") {
          visitExpression(arg.argument);
        } else {
          visitExpression(arg);
        }
      }
      return;
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      attachFunctionBytecode(node);
      if (node.body.type === "BlockStatement") {
        visitStatements(node.body.body);
      } else {
        visitExpression(node.body);
      }
      return;
    default:
      return;
  }
}

function attachFunctionBytecode(node) {
  node.bytecode = compileFunctionExecutable(node);
}

function compileProgramExecutable(program) {
  const context = new BytecodeContext({ allowReturn: true });
  return compileRootExecutable(program.scope, program.body, context, true)
    ? {
        instructions: context.instructions,
        implicitReturnResult: true,
      }
    : null;
}

function compileFunctionExecutable(node) {
  const context = new BytecodeContext({ allowReturn: true });

  if (node.body.type === "BlockStatement") {
    if (!compileRootExecutable(node.scope, node.body.body, context, false)) {
      return null;
    }

    return {
      instructions: context.instructions,
      implicitReturnResult: false,
    };
  }

  if (!compileExpression(node.body, context)) {
    return null;
  }

  context.emit(OP.RETURN);
  return {
    instructions: context.instructions,
    implicitReturnResult: false,
  };
}

function compileRootExecutable(scope, statements, context, implicitReturnResult) {
  if (!compileStatements(statements, context)) {
    return false;
  }

  context.emit(implicitReturnResult ? OP.RETURN_RESULT : OP.RETURN_UNDEFINED);
  return true;
}

function compileStatements(statements, context) {
  for (const statement of statements) {
    if (!compileStatement(statement, context)) {
      return false;
    }
  }

  return true;
}

function compileStatement(node, context) {
  return withCheckpoint(context, () => {
    switch (node.type) {
      case "EmptyStatement":
        return true;
      case "ExpressionStatement":
        return compileExpressionStatement(node, context);
      case "VariableDeclaration":
        return compileVariableDeclaration(node, context, true);
      case "FunctionDeclaration":
        return compileFunctionDeclaration(node, context);
      case "BlockStatement":
        return compileBlockStatement(node, context);
      case "IfStatement":
        return compileIfStatement(node, context);
      case "WhileStatement":
        return compileWhileStatement(node, context);
      case "DoWhileStatement":
        return compileDoWhileStatement(node, context);
      case "ForStatement":
        return compileForStatement(node, context);
      case "ForInStatement":
        return compileForInStatement(node, context);
      case "ForOfStatement":
        return compileForOfStatement(node, context);
      case "SwitchStatement":
        return compileSwitchStatement(node, context);
      case "TryStatement":
        return compileTryStatement(node, context);
      case "ReturnStatement":
        return compileReturnStatement(node, context);
      case "ThrowStatement":
        return compileThrowStatement(node, context);
      case "BreakStatement":
        return compileBreakStatement(context);
      case "ContinueStatement":
        return compileContinueStatement(context);
      default:
        return false;
    }
  });
}

function compileExpressionStatement(node, context) {
  if (!compileExpression(node.expression, context)) {
    return false;
  }

  context.emit(OP.SET_RESULT);
  return true;
}

function compileVariableDeclaration(node, context, setResult) {
  for (let index = 0; index < node.declarations.length; index += 1) {
    const declaration = node.declarations[index];
    if (declaration.init) {
      if (!compileExpression(declaration.init, context)) {
        return false;
      }
    } else {
      context.emit(OP.PUSH_CONST, undefined);
    }

    const isLast = index === node.declarations.length - 1;
    if (setResult && isLast) {
      context.emit(OP.DUP);
    }

    if (declaration.id.type === "Identifier") {
      emitDeclarationWrite(node.kind, declaration.id, context);
    } else {
      context.emit(OP.BIND_PATTERN, declaration.id, node.kind, "declare");
    }

    if (setResult && isLast) {
      context.emit(OP.SET_RESULT);
    }
  }

  return true;
}

function compileFunctionDeclaration(node, context) {
  emitLoadIdentifier(node.id.binding ?? null, node.id.name, context);
  context.emit(OP.SET_RESULT);
  return true;
}

function compileBlockStatement(node, context) {
  context.emit(OP.ENTER_SCOPE, node.scope);
  context.scopeDepth += 1;
  context.emit(OP.PUSH_RESULT_SLOT);
  context.resultDepth += 1;

  if (!compileStatements(node.body, context)) {
    return false;
  }

  context.emit(OP.POP_RESULT_SLOT);
  context.resultDepth -= 1;
  context.emit(OP.EXIT_SCOPE);
  context.scopeDepth -= 1;
  context.emit(OP.SET_RESULT);
  return true;
}

function compileIfStatement(node, context) {
  if (!compileExpression(node.test, context)) {
    return false;
  }

  const elseJump = context.emit(OP.JUMP_IF_FALSE, null);
  if (!compileStatement(node.consequent, context)) {
    return false;
  }

  if (!node.alternate) {
    context.patch(elseJump, context.instructions.length);
    return true;
  }

  const endJump = context.emit(OP.JUMP, null);
  context.patch(elseJump, context.instructions.length);
  if (!compileStatement(node.alternate, context)) {
    return false;
  }
  context.patch(endJump, context.instructions.length);
  return true;
}

function compileWhileStatement(node, context) {
  context.emit(OP.PUSH_RESULT_SLOT);
  context.resultDepth += 1;

  const start = context.instructions.length;
  if (!compileExpression(node.test, context)) {
    return false;
  }

  const exitJump = context.emit(OP.JUMP_IF_FALSE, null);
  const loop = context.pushLoop(start);

  if (!compileStatement(node.body, context)) {
    return false;
  }

  const continueTarget = context.instructions.length;
  context.patchJumps(loop.continueJumps, continueTarget);
  context.emit(OP.JUMP, start);

  const exitTarget = context.instructions.length;
  context.patch(exitJump, exitTarget);
  context.patchJumps(loop.breakJumps, exitTarget);
  context.popLoop();

  context.emit(OP.POP_RESULT_SLOT);
  context.resultDepth -= 1;
  context.emit(OP.SET_RESULT);
  return true;
}

function compileDoWhileStatement(node, context) {
  context.emit(OP.PUSH_RESULT_SLOT);
  context.resultDepth += 1;

  const start = context.instructions.length;
  const loop = context.pushLoop(null);

  if (!compileStatement(node.body, context)) {
    return false;
  }

  const continueTarget = context.instructions.length;
  if (!compileExpression(node.test, context)) {
    return false;
  }

  const exitJump = context.emit(OP.JUMP_IF_FALSE, null);
  context.patchJumps(loop.continueJumps, continueTarget);
  context.emit(OP.JUMP, start);

  const exitTarget = context.instructions.length;
  context.patch(exitJump, exitTarget);
  context.patchJumps(loop.breakJumps, exitTarget);
  context.popLoop();

  context.emit(OP.POP_RESULT_SLOT);
  context.resultDepth -= 1;
  context.emit(OP.SET_RESULT);
  return true;
}

function compileForStatement(node, context) {
  context.emit(OP.ENTER_SCOPE, node.scope);
  context.scopeDepth += 1;
  context.emit(OP.PUSH_RESULT_SLOT);
  context.resultDepth += 1;

  if (node.init) {
    if (node.init.type === "VariableDeclaration") {
      if (!compileVariableDeclaration(node.init, context, false)) {
        return false;
      }
    } else if (!compileExpression(node.init, context)) {
      return false;
    } else {
      context.emit(OP.POP);
    }
  }

  const testTarget = context.instructions.length;
  let exitJump = null;

  if (node.test) {
    if (!compileExpression(node.test, context)) {
      return false;
    }
    exitJump = context.emit(OP.JUMP_IF_FALSE, null);
  }

  const loop = context.pushLoop(null);
  if (!compileStatement(node.body, context)) {
    return false;
  }

  const continueTarget = context.instructions.length;
  if (node.update) {
    if (!compileExpression(node.update, context)) {
      return false;
    }
    context.emit(OP.POP);
  }

  context.patchJumps(loop.continueJumps, continueTarget);
  context.emit(OP.JUMP, testTarget);

  const exitTarget = context.instructions.length;
  if (exitJump !== null) {
    context.patch(exitJump, exitTarget);
  }
  context.patchJumps(loop.breakJumps, exitTarget);
  context.popLoop();

  context.emit(OP.POP_RESULT_SLOT);
  context.resultDepth -= 1;
  context.emit(OP.EXIT_SCOPE);
  context.scopeDepth -= 1;
  context.emit(OP.SET_RESULT);
  return true;
}

function compileForInStatement(node, context) {
  return compileEnumeratedLoop(node, context, OP.ENUM_KEYS);
}

function compileForOfStatement(node, context) {
  return compileEnumeratedLoop(node, context, OP.ITER_VALUES);
}

function compileEnumeratedLoop(node, context, enumerationOpcode) {
  context.emit(OP.ENTER_SCOPE, node.scope);
  context.scopeDepth += 1;
  context.emit(OP.PUSH_RESULT_SLOT);
  context.resultDepth += 1;

  if (!compileExpression(node.right, context)) {
    return false;
  }
  context.emit(enumerationOpcode);

  const valuesTemp = context.allocateTemp();
  const indexTemp = context.allocateTemp();
  context.emit(OP.STORE_TEMP, valuesTemp);
  context.emit(OP.PUSH_CONST, 0);
  context.emit(OP.STORE_TEMP, indexTemp);

  const testTarget = context.instructions.length;
  context.emit(OP.LOAD_TEMP, indexTemp);
  context.emit(OP.LOAD_TEMP, valuesTemp);
  context.emit(OP.GET_MEMBER_NAMED, "length");
  context.emit(OP.BINARY, "<");
  const exitJump = context.emit(OP.JUMP_IF_FALSE, null);

  const loop = context.pushLoop(null);
  context.emit(OP.LOAD_TEMP, valuesTemp);
  context.emit(OP.LOAD_TEMP, indexTemp);
  context.emit(OP.GET_MEMBER_COMPUTED);
  if (!compileLoopBindingFromStack(node.left, context)) {
    return false;
  }

  if (!compileStatement(node.body, context)) {
    return false;
  }

  const continueTarget = context.instructions.length;
  context.emit(OP.LOAD_TEMP, indexTemp);
  context.emit(OP.PUSH_CONST, 1);
  context.emit(OP.BINARY, "+");
  context.emit(OP.STORE_TEMP, indexTemp);
  context.patchJumps(loop.continueJumps, continueTarget);
  context.emit(OP.JUMP, testTarget);

  const exitTarget = context.instructions.length;
  context.patch(exitJump, exitTarget);
  context.patchJumps(loop.breakJumps, exitTarget);
  context.popLoop();

  context.emit(OP.POP_RESULT_SLOT);
  context.resultDepth -= 1;
  context.emit(OP.EXIT_SCOPE);
  context.scopeDepth -= 1;
  context.emit(OP.SET_RESULT);
  return true;
}

function compileSwitchStatement(node, context) {
  context.emit(OP.PUSH_RESULT_SLOT);
  context.resultDepth += 1;

  if (!compileExpression(node.discriminant, context)) {
    return false;
  }

  const discriminantTemp = context.allocateTemp();
  context.emit(OP.STORE_TEMP, discriminantTemp);

  const bodyJumps = node.cases.map(() => []);
  let defaultIndex = -1;

  for (let index = 0; index < node.cases.length; index += 1) {
    const switchCase = node.cases[index];
    if (switchCase.test === null) {
      defaultIndex = index;
      continue;
    }

    context.emit(OP.LOAD_TEMP, discriminantTemp);
    if (!compileExpression(switchCase.test, context)) {
      return false;
    }
    context.emit(OP.BINARY, "===");
    const falseJump = context.emit(OP.JUMP_IF_FALSE, null);
    bodyJumps[index].push(context.emit(OP.JUMP, null));
    context.patch(falseJump, context.instructions.length);
  }

  const noMatchJump = context.emit(OP.JUMP, null);
  const breakable = context.pushBreakable();
  const bodyTargets = new Array(node.cases.length).fill(null);

  for (let index = 0; index < node.cases.length; index += 1) {
    bodyTargets[index] = context.instructions.length;
    context.patchJumps(bodyJumps[index], bodyTargets[index]);
    if (!compileStatements(node.cases[index].consequent, context)) {
      return false;
    }
  }

  const exitTarget = context.instructions.length;
  context.patch(noMatchJump, defaultIndex >= 0 ? bodyTargets[defaultIndex] : exitTarget);
  context.patchJumps(breakable.breakJumps, exitTarget);
  context.popBreakable();

  context.emit(OP.POP_RESULT_SLOT);
  context.resultDepth -= 1;
  context.emit(OP.SET_RESULT);
  return true;
}

function compileReturnStatement(node, context) {
  if (!context.allowReturn) {
    return false;
  }

  if (context.abruptFinalizers.length > 0) {
    const temp = context.allocateTemp();
    if (node.argument) {
      if (!compileExpression(node.argument, context)) {
        return false;
      }
    } else {
      context.emit(OP.PUSH_CONST, undefined);
    }
    context.emit(OP.STORE_TEMP, temp);
    if (!compileAbruptFinalizers(context)) {
      return false;
    }
    context.emit(OP.LOAD_TEMP, temp);
    context.emit(OP.RETURN);
    return true;
  }

  if (node.argument) {
    if (!compileExpression(node.argument, context)) {
      return false;
    }
  } else {
    context.emit(OP.PUSH_CONST, undefined);
  }

  context.emit(OP.RETURN);
  return true;
}

function compileThrowStatement(node, context) {
  if (!compileExpression(node.argument, context)) {
    return false;
  }

  context.emit(OP.THROW);
  return true;
}

function compileBreakStatement(context) {
  const breakable = context.currentBreakable();
  if (!breakable) {
    return false;
  }

  const abruptState = compileAbruptFinalizers(context);
  if (!abruptState) {
    return false;
  }
  emitBreakableUnwind(breakable, context, abruptState);
  breakable.breakJumps.push(context.emit(OP.JUMP, null));
  return true;
}

function compileContinueStatement(context) {
  const loop = context.currentLoop();
  if (!loop) {
    return false;
  }

  const abruptState = compileAbruptFinalizers(context);
  if (!abruptState) {
    return false;
  }
  emitLoopUnwind(loop, context, abruptState);
  loop.continueJumps.push(context.emit(OP.JUMP, null));
  return true;
}

function compileLoopBindingFromStack(left, context) {
  if (left.type === "VariableDeclaration") {
    if (left.declarations.length !== 1) {
      return false;
    }

    const declaration = left.declarations[0];
    if (declaration.init) {
      return false;
    }

    context.emit(OP.BIND_PATTERN, declaration.id, left.kind, "loop");
    return true;
  }

  context.emit(OP.BIND_PATTERN, left, "let", "assign");
  return true;
}

function compileTryStatement(node, context) {
  const hasCatch = Boolean(node.handler);
  const hasFinally = Boolean(node.finalizer);
  const baseScopeDepth = context.scopeDepth;
  const baseResultDepth = context.resultDepth;
  const thrownTemp = context.allocateTemp();
  let tryThrowHandler = null;
  let tryNormalJump = null;
  let catchThrowHandler = null;
  let catchNormalJump = null;

  if (hasCatch || hasFinally) {
    tryThrowHandler = context.emit(
      OP.PUSH_THROW_HANDLER,
      null,
      thrownTemp,
      baseScopeDepth,
      baseResultDepth
    );
  }

  if (hasFinally) {
    context.pushAbruptFinally(node.finalizer, {
      popThrowHandler: true,
      scopeDepth: baseScopeDepth,
      resultDepth: baseResultDepth,
    });
  }
  if (!compileStatement(node.block, context)) {
    return false;
  }
  if (hasFinally) {
    context.popAbruptFinally();
  }

  if (tryThrowHandler !== null) {
    context.emit(OP.POP_THROW_HANDLER);
    tryNormalJump = context.emit(OP.JUMP, null);
  }

  if (hasCatch) {
    const catchStart = context.instructions.length;
    context.patch(tryThrowHandler, catchStart);

    context.emit(OP.ENTER_SCOPE, node.handler.scope);
    context.scopeDepth += 1;

    if (node.handler.param) {
      context.emit(OP.LOAD_TEMP, thrownTemp);
      emitDeclarationWrite("let", node.handler.param, context);
    }

    if (hasFinally) {
      catchThrowHandler = context.emit(
        OP.PUSH_THROW_HANDLER,
        null,
        thrownTemp,
        baseScopeDepth,
        baseResultDepth
      );
      context.pushAbruptFinally(node.finalizer, {
        popThrowHandler: true,
        scopeDepth: baseScopeDepth,
        resultDepth: baseResultDepth,
      });
    }

    if (!compileStatement(node.handler.body, context)) {
      return false;
    }

    if (hasFinally) {
      context.popAbruptFinally();
      context.emit(OP.POP_THROW_HANDLER);
    }

    context.emit(OP.EXIT_SCOPE);
    context.scopeDepth -= 1;

    if (hasFinally) {
      catchNormalJump = context.emit(OP.JUMP, null);
    }
  }

  if (hasFinally) {
    const normalFinallyStart = context.instructions.length;
    if (tryNormalJump !== null) {
      context.patch(tryNormalJump, normalFinallyStart);
    }
    if (catchNormalJump !== null) {
      context.patch(catchNormalJump, normalFinallyStart);
    }

    if (!compileStatement(node.finalizer, context)) {
      return false;
    }
    const endJump = context.emit(OP.JUMP, null);

    const throwFinallyStart = context.instructions.length;
    if (hasCatch) {
      context.patch(catchThrowHandler, throwFinallyStart);
    } else {
      context.patch(tryThrowHandler, throwFinallyStart);
    }

    if (!compileStatement(node.finalizer, context)) {
      return false;
    }
    context.emit(OP.LOAD_TEMP, thrownTemp);
    context.emit(OP.THROW);

    context.patch(endJump, context.instructions.length);
    return true;
  }

  if (hasCatch && tryNormalJump !== null) {
    context.patch(tryNormalJump, context.instructions.length);
    return true;
  }

  return false;
}

function compileExpression(node, context) {
  switch (node.type) {
    case "Literal":
      context.emit(OP.PUSH_CONST, node.value);
      return true;
    case "RegExpLiteral":
      context.emit(OP.PUSH_REGEX, node.pattern, node.flags);
      return true;
    case "Identifier":
      emitLoadIdentifier(node.resolution ?? null, node.name, context);
      return true;
    case "ThisExpression":
      emitLoadIdentifier(node.resolution ?? null, "this", context);
      return true;
    case "ArrayExpression":
      return compileArrayExpression(node, context);
    case "ObjectExpression":
      return compileObjectExpression(node, context);
    case "UnaryExpression":
      return compileUnaryExpression(node, context);
    case "BinaryExpression":
      return compileBinaryExpression(node, context);
    case "LogicalExpression":
      return compileLogicalExpression(node, context);
    case "ConditionalExpression":
      return compileConditionalExpression(node, context);
    case "SequenceExpression":
      return compileSequenceExpression(node, context);
    case "AssignmentExpression":
      return compileAssignmentExpression(node, context);
    case "MemberExpression":
      return compileMemberExpression(node, context);
    case "CallExpression":
      return compileCallExpression(node, context);
    case "NewExpression":
      return compileNewExpression(node, context);
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      context.emit(OP.MAKE_FUNCTION, node);
      return true;
    case "UpdateExpression":
      return compileUpdateExpression(node, context);
    default:
      return false;
  }
}

function compileArrayExpression(node, context) {
  const hasSpread = node.elements.some((el) => el?.type === "SpreadElement");

  for (const element of node.elements) {
    if (!element) {
      context.emit(OP.PUSH_CONST, undefined);
      continue;
    }
    if (element.type === "SpreadElement") {
      if (!compileExpression(element.argument, context)) {
        return false;
      }
      continue;
    }
    if (!compileExpression(element, context)) {
      return false;
    }
  }

  if (hasSpread) {
    const flags = node.elements.map((el) => el?.type === "SpreadElement");
    context.emit(OP.MAKE_ARRAY_SPREAD, flags);
  } else {
    context.emit(OP.MAKE_ARRAY, node.elements.length);
  }
  return true;
}

function compileObjectExpression(node, context) {
  const descriptors = [];

  for (const property of node.properties) {
    if (property.computed) {
      if (!compileExpression(property.key, context)) {
        return false;
      }
      descriptors.push(COMPUTED);
    } else {
      descriptors.push(property.key);
    }

    if (!compileExpression(property.value, context)) {
      return false;
    }
  }

  context.emit(OP.MAKE_OBJECT, descriptors);
  return true;
}

function compileUnaryExpression(node, context) {
  if (node.operator === "typeof" && node.argument.type === "Identifier") {
    if (node.argument.resolution) {
      context.emit(OP.TYPEOF_RESOLVED, node.argument.resolution);
    } else {
      context.emit(OP.TYPEOF_NAME, node.argument.name);
    }
    return true;
  }

  if (node.operator === "delete") {
    if (node.argument.type === "MemberExpression" && !node.argument.optional && !node.argument.chain) {
      if (!compileExpression(node.argument.object, context)) {
        return false;
      }
      if (node.argument.computed) {
        if (!compileExpression(node.argument.property, context)) {
          return false;
        }
        context.emit(OP.DELETE_MEMBER_COMPUTED);
      } else {
        context.emit(OP.DELETE_MEMBER_NAMED, node.argument.property.name);
      }
      return true;
    }

    context.emit(OP.PUSH_CONST, true);
    return true;
  }

  if (!compileExpression(node.argument, context)) {
    return false;
  }

  context.emit(OP.UNARY, node.operator);
  return true;
}

function compileBinaryExpression(node, context) {
  if (!compileExpression(node.left, context)) {
    return false;
  }
  if (!compileExpression(node.right, context)) {
    return false;
  }
  context.emit(OP.BINARY, node.operator);
  return true;
}

function compileLogicalExpression(node, context) {
  if (!compileExpression(node.left, context)) {
    return false;
  }

  let jumpIndex;
  switch (node.operator) {
    case "&&":
      jumpIndex = context.emit(OP.JUMP_IF_FALSE_KEEP, null);
      break;
    case "||":
      jumpIndex = context.emit(OP.JUMP_IF_TRUE_KEEP, null);
      break;
    case "??":
      jumpIndex = context.emit(OP.JUMP_IF_NOT_NULLISH_KEEP, null);
      break;
    default:
      return false;
  }

  context.emit(OP.POP);
  if (!compileExpression(node.right, context)) {
    return false;
  }
  context.patch(jumpIndex, context.instructions.length);
  return true;
}

function compileConditionalExpression(node, context) {
  if (!compileExpression(node.test, context)) {
    return false;
  }

  const elseJump = context.emit(OP.JUMP_IF_FALSE, null);
  if (!compileExpression(node.consequent, context)) {
    return false;
  }
  const endJump = context.emit(OP.JUMP, null);
  context.patch(elseJump, context.instructions.length);
  if (!compileExpression(node.alternate, context)) {
    return false;
  }
  context.patch(endJump, context.instructions.length);
  return true;
}

function compileSequenceExpression(node, context) {
  for (let index = 0; index < node.expressions.length; index += 1) {
    if (!compileExpression(node.expressions[index], context)) {
      return false;
    }
    if (index < node.expressions.length - 1) {
      context.emit(OP.POP);
    }
  }

  return true;
}

function compileAssignmentExpression(node, context) {
  if (node.left.type === "Identifier") {
    if (!compileExpression(node.right, context)) {
      return false;
    }

    if (node.left.resolution) {
      context.emit(OP.ASSIGN_RESOLVED, node.operator, node.left.resolution);
    } else {
      context.emit(OP.ASSIGN_NAME, node.operator, node.left.name);
    }
    return true;
  }

  if (node.operator === "=" && node.left.type !== "MemberExpression") {
    if (!compileExpression(node.right, context)) {
      return false;
    }
    context.emit(OP.DUP);
    context.emit(OP.BIND_PATTERN, node.left, "let", "assign");
    return true;
  }

  if (node.left.type !== "MemberExpression" || node.left.optional || node.left.chain) {
    return false;
  }

  if (!compileExpression(node.left.object, context)) {
    return false;
  }
  if (node.left.computed && !compileExpression(node.left.property, context)) {
    return false;
  }
  if (!compileExpression(node.right, context)) {
    return false;
  }

  if (node.left.computed) {
    context.emit(OP.ASSIGN_MEMBER_COMPUTED, node.operator);
  } else {
    context.emit(OP.ASSIGN_MEMBER_NAMED, node.operator, node.left.property.name);
  }

  return true;
}

function compileMemberExpression(node, context) {
  if (node.optional || node.chain) {
    return compileChainExpression(node, context);
  }

  if (!compileExpression(node.object, context)) {
    return false;
  }

  if (node.computed) {
    if (!compileExpression(node.property, context)) {
      return false;
    }
    context.emit(OP.GET_MEMBER_COMPUTED);
  } else {
    context.emit(OP.GET_MEMBER_NAMED, node.property.name);
  }

  return true;
}

function compileCallExpression(node, context) {
  if (node.optional || node.chain) {
    return compileChainExpression(node, context);
  }

  const spread = hasSpreadArgs(node.arguments);

  if (node.callee.type === "MemberExpression") {
    if (node.callee.optional || node.callee.chain) {
      return compileChainExpression(node, context);
    }
    if (!compileExpression(node.callee.object, context)) {
      return false;
    }
    if (node.callee.computed && !compileExpression(node.callee.property, context)) {
      return false;
    }
    if (!compileArguments(node.arguments, context)) {
      return false;
    }
    if (spread) {
      const flags = spreadFlags(node.arguments);
      if (node.callee.computed) {
        context.emit(OP.CALL_MEMBER_COMPUTED_SPREAD, flags);
      } else {
        context.emit(OP.CALL_MEMBER_NAMED_SPREAD, node.callee.property.name, flags);
      }
    } else {
      if (node.callee.computed) {
        context.emit(OP.CALL_MEMBER_COMPUTED, node.arguments.length);
      } else {
        context.emit(OP.CALL_MEMBER_NAMED, node.callee.property.name, node.arguments.length);
      }
    }
    return true;
  }

  if (!compileExpression(node.callee, context)) {
    return false;
  }
  if (!compileArguments(node.arguments, context)) {
    return false;
  }
  if (spread) {
    context.emit(OP.CALL_SPREAD, spreadFlags(node.arguments));
  } else {
    context.emit(OP.CALL, node.arguments.length);
  }
  return true;
}

function compileChainExpression(node, context) {
  const chain = extractChain(node);
  if (!chain || chain.segments.length === 0) {
    return false;
  }

  if (!compileExpression(chain.base, context)) {
    return false;
  }

  const currentTemp = context.allocateTemp();
  const thisTemp = context.allocateTemp();
  const endJumps = [];

  context.emit(OP.STORE_TEMP, currentTemp);
  context.emit(OP.PUSH_CONST, undefined);
  context.emit(OP.STORE_TEMP, thisTemp);

  for (const segment of chain.segments) {
    context.emit(OP.LOAD_TEMP, currentTemp);

    if (segment.optional) {
      const liveJump = context.emit(OP.JUMP_IF_NOT_NULLISH_KEEP, null);
      context.emit(OP.POP);
      context.emit(OP.PUSH_CONST, null);
      endJumps.push(context.emit(OP.JUMP, null));
      context.patch(liveJump, context.instructions.length);
    }

    if (segment.type === "member") {
      context.emit(OP.DUP);
      context.emit(OP.STORE_TEMP, thisTemp);

      if (segment.computed) {
        if (!compileExpression(segment.property, context)) {
          return false;
        }
        context.emit(OP.GET_MEMBER_COMPUTED);
      } else {
        context.emit(OP.GET_MEMBER_NAMED, segment.property.name);
      }

      context.emit(OP.STORE_TEMP, currentTemp);
      continue;
    }

    if (segment.memberCall) {
      context.emit(OP.LOAD_TEMP, thisTemp);
    }

    if (!compileArguments(segment.arguments, context)) {
      return false;
    }

    if (hasSpreadArgs(segment.arguments)) {
      const flags = spreadFlags(segment.arguments);
      if (segment.memberCall) {
        context.emit(OP.CALL_WITH_THIS_SPREAD, flags);
      } else {
        context.emit(OP.CALL_SPREAD, flags);
      }
    } else {
      if (segment.memberCall) {
        context.emit(OP.CALL_WITH_THIS, segment.arguments.length);
      } else {
        context.emit(OP.CALL, segment.arguments.length);
      }
    }

    context.emit(OP.STORE_TEMP, currentTemp);
  }

  context.emit(OP.LOAD_TEMP, currentTemp);
  context.patchJumps(endJumps, context.instructions.length);
  return true;
}

function compileNewExpression(node, context) {
  if (!compileExpression(node.callee, context)) {
    return false;
  }
  if (!compileArguments(node.arguments, context)) {
    return false;
  }
  if (hasSpreadArgs(node.arguments)) {
    context.emit(OP.CONSTRUCT_SPREAD, spreadFlags(node.arguments));
  } else {
    context.emit(OP.CONSTRUCT, node.arguments.length);
  }
  return true;
}

function compileUpdateExpression(node, context) {
  if (node.argument.type === "Identifier") {
    if (node.argument.resolution) {
      context.emit(OP.UPDATE_RESOLVED, node.argument.resolution, node.operator, node.prefix);
    } else {
      context.emit(OP.UPDATE_NAME, node.argument.name, node.operator, node.prefix);
    }
    return true;
  }

  if (node.argument.type !== "MemberExpression" || node.argument.optional || node.argument.chain) {
    return false;
  }

  if (!compileExpression(node.argument.object, context)) {
    return false;
  }

  if (node.argument.computed) {
    if (!compileExpression(node.argument.property, context)) {
      return false;
    }
    context.emit(OP.UPDATE_MEMBER_COMPUTED, node.operator, node.prefix);
  } else {
    context.emit(OP.UPDATE_MEMBER_NAMED, node.argument.property.name, node.operator, node.prefix);
  }

  return true;
}

function extractChain(node) {
  switch (node.type) {
    case "MemberExpression": {
      const chain = extractChain(node.object);
      if (!chain) {
        return null;
      }
      chain.segments.push({
        type: "member",
        computed: node.computed,
        property: node.property,
        optional: node.optional,
      });
      return chain;
    }
    case "CallExpression": {
      const chain = extractChain(node.callee);
      if (!chain) {
        return null;
      }
      chain.segments.push({
        type: "call",
        arguments: node.arguments,
        optional: node.optional,
        memberCall: node.callee.type === "MemberExpression",
      });
      return chain;
    }
    default:
      return {
        base: node,
        segments: [],
      };
  }
}

function compileArguments(args, context) {
  for (const arg of args) {
    if (arg?.type === "SpreadElement") {
      if (!compileExpression(arg.argument, context)) {
        return false;
      }
      continue;
    }
    if (!compileExpression(arg, context)) {
      return false;
    }
  }

  return true;
}

function hasSpreadArgs(args) {
  return args.some((arg) => arg?.type === "SpreadElement");
}

function spreadFlags(args) {
  return args.map((arg) => arg?.type === "SpreadElement");
}

function emitLoadIdentifier(resolution, name, context) {
  if (resolution) {
    context.emit(OP.LOAD_RESOLVED, resolution);
  } else {
    context.emit(OP.LOAD_NAME, name);
  }
}

function emitDeclarationWrite(kind, identifier, context) {
  if (kind === "var") {
    if (identifier.binding) {
      context.emit(OP.STORE_RESOLVED, identifier.binding);
    } else {
      context.emit(OP.STORE_NAME, identifier.name);
    }
    return;
  }

  if (identifier.binding) {
    context.emit(OP.DECLARE_RESOLVED, kind, identifier.binding);
  } else {
    context.emit(OP.DECLARE_NAME, kind, identifier.name);
  }
}

function emitLoopUnwind(loop, context, runtimeState = context) {
  emitBreakableUnwind(loop, context, runtimeState);
}

function emitBreakableUnwind(breakable, context, runtimeState = context) {
  const scopeCount = runtimeState.scopeDepth - breakable.baseScopeDepth;
  const resultCount = runtimeState.resultDepth - breakable.baseResultDepth;
  if (scopeCount > 0 || resultCount > 0) {
    context.emit(OP.UNWIND, scopeCount, resultCount);
  }
}

function compileAbruptFinalizers(context) {
  const originalDepths = {
    scopeDepth: context.scopeDepth,
    resultDepth: context.resultDepth,
    stackLength: context.abruptFinalizers.length,
  };

  for (let index = originalDepths.stackLength - 1; index >= 0; index -= 1) {
    const descriptor = context.abruptFinalizers[index];
    const scopeCount = context.scopeDepth - descriptor.scopeDepth;
    const resultCount = context.resultDepth - descriptor.resultDepth;

    if (scopeCount > 0 || resultCount > 0) {
      context.emit(OP.UNWIND, scopeCount, resultCount);
      context.scopeDepth = descriptor.scopeDepth;
      context.resultDepth = descriptor.resultDepth;
    }

    if (descriptor.popThrowHandler) {
      context.emit(OP.POP_THROW_HANDLER);
    }
    context.abruptFinalizers.length = index;
    if (!compileStatement(descriptor.node, context)) {
      context.abruptFinalizers.length = originalDepths.stackLength;
      context.scopeDepth = originalDepths.scopeDepth;
      context.resultDepth = originalDepths.resultDepth;
      return null;
    }
  }

  const runtimeState = {
    scopeDepth: context.scopeDepth,
    resultDepth: context.resultDepth,
  };
  context.abruptFinalizers.length = originalDepths.stackLength;
  context.scopeDepth = originalDepths.scopeDepth;
  context.resultDepth = originalDepths.resultDepth;
  return runtimeState;
}

function popArgs(stack, count) {
  const args = new Array(count);
  for (let index = count - 1; index >= 0; index -= 1) {
    args[index] = stack.pop();
  }
  return args;
}

function popSpreadArgs(stack, flags) {
  const count = flags.length;
  const items = new Array(count);
  for (let index = count - 1; index >= 0; index -= 1) {
    items[index] = stack.pop();
  }
  const args = [];
  for (let index = 0; index < count; index += 1) {
    if (flags[index]) {
      const v = items[index];
      if (Array.isArray(v)) {
        args.push(...v);
      } else if (typeof v === "string") {
        args.push(...Array.from(v));
      } else {
        args.push(...Array.from(v ?? []));
      }
    } else {
      args.push(items[index]);
    }
  }
  return args;
}

function unwindScopes(env, count) {
  let current = env;
  for (let index = 0; index < count; index += 1) {
    current = current.parent;
  }
  return current;
}

function withCheckpoint(context, callback) {
  const instructionLength = context.instructions.length;
  const scopeDepth = context.scopeDepth;
  const resultDepth = context.resultDepth;
  const loopCount = context.loops.length;
  const breakableCount = context.breakables.length;
  const abruptFinallyCount = context.abruptFinalizers.length;
  const tempCount = context.tempCount;
  const succeeded = callback();

  if (!succeeded) {
    context.instructions.length = instructionLength;
    context.scopeDepth = scopeDepth;
    context.resultDepth = resultDepth;
    context.loops.length = loopCount;
    context.breakables.length = breakableCount;
    context.abruptFinalizers.length = abruptFinallyCount;
    context.tempCount = tempCount;
  }

  return succeeded;
}

class BytecodeContext {
  constructor(options) {
    this.instructions = [];
    this.scopeDepth = 0;
    this.resultDepth = 1;
    this.loops = [];
    this.breakables = [];
    this.abruptFinalizers = [];
    this.tempCount = 0;
    this.allowReturn = options.allowReturn === true;
  }

  emit(opcode, ...args) {
    const instruction = [opcode, ...args];
    this.instructions.push(instruction);
    return this.instructions.length - 1;
  }

  patch(index, target) {
    this.instructions[index][1] = target;
  }

  patchJumps(indices, target) {
    for (const index of indices) {
      this.instructions[index][1] = target;
    }
  }

  pushLoop(continueTarget) {
    const loop = {
      continueTarget,
      breakJumps: [],
      continueJumps: [],
      baseScopeDepth: this.scopeDepth,
      baseResultDepth: this.resultDepth,
    };
    this.loops.push(loop);
    this.breakables.push(loop);
    return loop;
  }

  popLoop() {
    const loop = this.loops.pop();
    this.breakables.pop();
    return loop;
  }

  currentLoop() {
    return this.loops[this.loops.length - 1] ?? null;
  }

  pushBreakable() {
    const breakable = {
      breakJumps: [],
      baseScopeDepth: this.scopeDepth,
      baseResultDepth: this.resultDepth,
    };
    this.breakables.push(breakable);
    return breakable;
  }

  popBreakable() {
    return this.breakables.pop();
  }

  currentBreakable() {
    return this.breakables[this.breakables.length - 1] ?? null;
  }

  allocateTemp() {
    const index = this.tempCount;
    this.tempCount += 1;
    return index;
  }

  pushAbruptFinally(node, options = {}) {
    this.abruptFinalizers.push({
      node,
      popThrowHandler: options.popThrowHandler === true,
      scopeDepth: options.scopeDepth ?? this.scopeDepth,
      resultDepth: options.resultDepth ?? this.resultDepth,
    });
  }

  popAbruptFinally() {
    return this.abruptFinalizers.pop();
  }
}

function applyUnaryOperator(operator, value) {
  switch (operator) {
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
    case "typeof":
      return typeOf(value);
    default:
      throw new JSLiteRuntimeError(`Unsupported unary operator '${operator}'`);
  }
}

function applyBinaryOperator(operator, left, right) {
  switch (operator) {
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
      throw new JSLiteRuntimeError(`Unsupported binary operator '${operator}'`);
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
