import { BUILTIN_GLOBAL_NAMES } from "./runtime.js";

let nextScopeId = 1;

export function compileProgram(program) {
  const rootScope = createScope("function", null);
  program.scope = rootScope;
  program.hoistedFunctions = rootScope.hoistedFunctions;
  rootScope.builtinBindings = [];

  rootScope.thisBinding = declareBinding(rootScope, "this");

  for (const name of BUILTIN_GLOBAL_NAMES) {
    const binding = declareBinding(rootScope, name);
    rootScope.builtinBindings.push({
      name,
      slot: binding.slot,
    });
  }

  prepareStatements(program.body, rootScope, rootScope);
  resolveStatements(program.body, rootScope, rootScope);

  return program;
}

function createScope(type, parent) {
  const scope = {
    id: nextScopeId += 1,
    type,
    parent,
    functionScope: null,
    bindingsByName: new Map(),
    slotCount: 0,
    varSlots: [],
    hoistedFunctions: [],
    thisBinding: null,
    selfBinding: null,
  };

  scope.functionScope = type === "function"
    ? scope
    : (parent?.functionScope ?? scope);

  return scope;
}

function declareBinding(scope, name, options = {}) {
  let binding = scope.bindingsByName.get(name);
  if (!binding) {
    binding = {
      name,
      slot: scope.slotCount,
      scope,
    };
    scope.slotCount += 1;
    scope.bindingsByName.set(name, binding);
  }

  if (options.varLike === true && !scope.varSlots.includes(binding.slot)) {
    scope.varSlots.push(binding.slot);
  }

  return binding;
}

function createResolution(fromScope, binding) {
  let depth = 0;
  let current = fromScope;

  while (current && current !== binding.scope) {
    current = current.parent;
    depth += 1;
  }

  if (!current) {
    return null;
  }

  return {
    depth,
    slot: binding.slot,
    name: binding.name,
  };
}

function prepareStatements(statements, lexicalScope, functionScope) {
  for (const statement of statements) {
    prepareStatement(statement, lexicalScope, functionScope);
  }
}

function prepareStatement(node, lexicalScope, functionScope) {
  switch (node.type) {
    case "EmptyStatement":
    case "BreakStatement":
    case "ContinueStatement":
      return;
    case "ExpressionStatement":
      prepareExpression(node.expression, lexicalScope, functionScope);
      return;
    case "VariableDeclaration":
      registerVariableDeclaration(node, lexicalScope, functionScope);
      for (const declaration of node.declarations) {
        if (declaration.init) {
          prepareExpression(declaration.init, lexicalScope, functionScope);
        }
      }
      return;
    case "FunctionDeclaration":
      registerFunctionDeclaration(node, lexicalScope, functionScope);
      prepareFunctionLike(node, lexicalScope);
      return;
    case "BlockStatement": {
      const blockScope = createScope("block", lexicalScope);
      node.scope = blockScope;
      prepareStatements(node.body, blockScope, functionScope);
      return;
    }
    case "IfStatement":
      prepareExpression(node.test, lexicalScope, functionScope);
      prepareStatement(node.consequent, lexicalScope, functionScope);
      if (node.alternate) {
        prepareStatement(node.alternate, lexicalScope, functionScope);
      }
      return;
    case "WhileStatement":
      prepareExpression(node.test, lexicalScope, functionScope);
      prepareStatement(node.body, lexicalScope, functionScope);
      return;
    case "DoWhileStatement":
      prepareStatement(node.body, lexicalScope, functionScope);
      prepareExpression(node.test, lexicalScope, functionScope);
      return;
    case "ForStatement": {
      const loopScope = createScope("block", lexicalScope);
      node.scope = loopScope;
      if (node.init) {
        if (node.init.type === "VariableDeclaration") {
          registerVariableDeclaration(node.init, loopScope, functionScope);
          for (const declaration of node.init.declarations) {
            if (declaration.init) {
              prepareExpression(declaration.init, loopScope, functionScope);
            }
          }
        } else {
          prepareExpression(node.init, loopScope, functionScope);
        }
      }
      if (node.test) {
        prepareExpression(node.test, loopScope, functionScope);
      }
      if (node.update) {
        prepareExpression(node.update, loopScope, functionScope);
      }
      prepareStatement(node.body, loopScope, functionScope);
      return;
    }
    case "ForInStatement":
    case "ForOfStatement": {
      const loopScope = createScope("block", lexicalScope);
      node.scope = loopScope;
      if (node.left.type === "VariableDeclaration") {
        registerVariableDeclaration(node.left, loopScope, functionScope);
      } else {
        preparePatternReference(node.left, loopScope, functionScope);
      }
      prepareExpression(node.right, loopScope, functionScope);
      prepareStatement(node.body, loopScope, functionScope);
      return;
    }
    case "SwitchStatement":
      prepareExpression(node.discriminant, lexicalScope, functionScope);
      for (const switchCase of node.cases) {
        if (switchCase.test) {
          prepareExpression(switchCase.test, lexicalScope, functionScope);
        }
        prepareStatements(switchCase.consequent, lexicalScope, functionScope);
      }
      return;
    case "ReturnStatement":
    case "ThrowStatement":
      if (node.argument) {
        prepareExpression(node.argument, lexicalScope, functionScope);
      }
      return;
    case "TryStatement":
      prepareStatement(node.block, lexicalScope, functionScope);
      if (node.handler) {
        const catchScope = createScope("block", lexicalScope);
        node.handler.scope = catchScope;
        if (node.handler.param) {
          registerBindingPattern(node.handler.param, catchScope, catchScope, "let");
        }
        prepareStatement(node.handler.body, catchScope, functionScope);
      }
      if (node.finalizer) {
        prepareStatement(node.finalizer, lexicalScope, functionScope);
      }
      return;
    default:
      return;
  }
}

function prepareExpression(node, lexicalScope, functionScope) {
  if (!node) {
    return;
  }

  switch (node.type) {
    case "Literal":
    case "RegExpLiteral":
    case "Identifier":
    case "ThisExpression":
      return;
    case "TemplateLiteral":
      for (const expression of node.expressions) {
        prepareExpression(expression, lexicalScope, functionScope);
      }
      return;
    case "ArrayExpression":
      for (const element of node.elements) {
        if (!element) {
          continue;
        }
        if (element.type === "SpreadElement") {
          prepareExpression(element.argument, lexicalScope, functionScope);
        } else {
          prepareExpression(element, lexicalScope, functionScope);
        }
      }
      return;
    case "ObjectExpression":
      for (const property of node.properties) {
        if (property.computed) {
          prepareExpression(property.key, lexicalScope, functionScope);
        }
        prepareExpression(property.value, lexicalScope, functionScope);
      }
      return;
    case "UnaryExpression":
    case "UpdateExpression":
      prepareExpression(node.argument, lexicalScope, functionScope);
      return;
    case "BinaryExpression":
    case "LogicalExpression":
      prepareExpression(node.left, lexicalScope, functionScope);
      prepareExpression(node.right, lexicalScope, functionScope);
      return;
    case "ConditionalExpression":
      prepareExpression(node.test, lexicalScope, functionScope);
      prepareExpression(node.consequent, lexicalScope, functionScope);
      prepareExpression(node.alternate, lexicalScope, functionScope);
      return;
    case "SequenceExpression":
      for (const expression of node.expressions) {
        prepareExpression(expression, lexicalScope, functionScope);
      }
      return;
    case "AssignmentExpression":
      prepareExpression(node.left, lexicalScope, functionScope);
      prepareExpression(node.right, lexicalScope, functionScope);
      return;
    case "MemberExpression":
      prepareExpression(node.object, lexicalScope, functionScope);
      if (node.computed) {
        prepareExpression(node.property, lexicalScope, functionScope);
      }
      return;
    case "CallExpression":
      prepareExpression(node.callee, lexicalScope, functionScope);
      prepareArgumentList(node.arguments, lexicalScope, functionScope);
      return;
    case "NewExpression":
      prepareExpression(node.callee, lexicalScope, functionScope);
      prepareArgumentList(node.arguments, lexicalScope, functionScope);
      return;
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      prepareFunctionLike(node, lexicalScope);
      return;
    default:
      return;
  }
}

function prepareArgumentList(args, lexicalScope, functionScope) {
  for (const arg of args) {
    if (arg.type === "SpreadElement") {
      prepareExpression(arg.argument, lexicalScope, functionScope);
    } else {
      prepareExpression(arg, lexicalScope, functionScope);
    }
  }
}

function preparePatternReference(pattern, lexicalScope, functionScope) {
  switch (pattern.type) {
    case "Identifier":
      return;
    case "AssignmentPattern":
      preparePatternReference(pattern.left, lexicalScope, functionScope);
      prepareExpression(pattern.right, lexicalScope, functionScope);
      return;
    case "RestElement":
      preparePatternReference(pattern.argument, lexicalScope, functionScope);
      return;
    case "ArrayPattern":
      for (const element of pattern.elements) {
        if (element) {
          preparePatternReference(element, lexicalScope, functionScope);
        }
      }
      return;
    case "ObjectPattern":
      for (const property of pattern.properties) {
        if (property.computed) {
          prepareExpression(property.key, lexicalScope, functionScope);
        }
        preparePatternReference(property.value, lexicalScope, functionScope);
      }
      return;
    default:
      return;
  }
}

function prepareFunctionLike(node, lexicalScope) {
  const functionScope = createScope("function", lexicalScope);
  node.scope = functionScope;
  functionScope.thisBinding = declareBinding(functionScope, "this");

  if (node.type === "FunctionExpression" && node.id) {
    const selfBinding = declareBinding(functionScope, node.id.name);
    functionScope.selfBinding = selfBinding;
    node.id.binding = createResolution(functionScope, selfBinding);
  }

  for (const param of node.params) {
    registerParameterPattern(param, functionScope);
  }

  if (node.body.type === "BlockStatement") {
    node.body.scope = functionScope;
    prepareStatements(node.body.body, functionScope, functionScope);
    return;
  }

  prepareExpression(node.body, functionScope, functionScope);
}

function registerParameterPattern(pattern, functionScope) {
  switch (pattern.type) {
    case "Identifier":
      registerBindingPattern(pattern, functionScope, functionScope, "var");
      return;
    case "AssignmentPattern":
      registerParameterPattern(pattern.left, functionScope);
      prepareExpression(pattern.right, functionScope, functionScope);
      return;
    case "RestElement":
      registerParameterPattern(pattern.argument, functionScope);
      return;
    case "ArrayPattern":
      for (const element of pattern.elements) {
        if (element) {
          registerParameterPattern(element, functionScope);
        }
      }
      return;
    case "ObjectPattern":
      for (const property of pattern.properties) {
        if (property.computed) {
          prepareExpression(property.key, functionScope, functionScope);
        }
        registerParameterPattern(property.value, functionScope);
      }
      return;
    default:
      return;
  }
}

function registerVariableDeclaration(node, lexicalScope, functionScope) {
  const targetScope = node.kind === "var" ? functionScope : lexicalScope;

  for (const declaration of node.declarations) {
    registerBindingPattern(declaration.id, lexicalScope, targetScope, node.kind);
  }
}

function registerFunctionDeclaration(node, lexicalScope, functionScope) {
  const binding = declareBinding(functionScope, node.id.name, { varLike: true });
  node.id.binding = createResolution(lexicalScope, binding);
  functionScope.hoistedFunctions.push({
    slot: binding.slot,
    node,
  });
}

function registerBindingPattern(pattern, lexicalScope, targetScope, kind) {
  switch (pattern.type) {
    case "Identifier": {
      const binding = declareBinding(targetScope, pattern.name, { varLike: kind === "var" });
      pattern.binding = createResolution(lexicalScope, binding);
      return;
    }
    case "AssignmentPattern":
      registerBindingPattern(pattern.left, lexicalScope, targetScope, kind);
      return;
    case "RestElement":
      registerBindingPattern(pattern.argument, lexicalScope, targetScope, kind);
      return;
    case "ArrayPattern":
      for (const element of pattern.elements) {
        if (element) {
          registerBindingPattern(element, lexicalScope, targetScope, kind);
        }
      }
      return;
    case "ObjectPattern":
      for (const property of pattern.properties) {
        registerBindingPattern(property.value, lexicalScope, targetScope, kind);
      }
      return;
    default:
      return;
  }
}

function resolveStatements(statements, lexicalScope, functionScope) {
  for (const statement of statements) {
    resolveStatement(statement, lexicalScope, functionScope);
  }
}

function resolveStatement(node, lexicalScope, functionScope) {
  switch (node.type) {
    case "EmptyStatement":
    case "BreakStatement":
    case "ContinueStatement":
      return;
    case "ExpressionStatement":
      resolveExpression(node.expression, lexicalScope, functionScope);
      return;
    case "VariableDeclaration":
      for (const declaration of node.declarations) {
        resolveBindingPattern(declaration.id, lexicalScope, functionScope);
        if (declaration.init) {
          resolveExpression(declaration.init, lexicalScope, functionScope);
        }
      }
      return;
    case "FunctionDeclaration":
      resolveFunctionLike(node, lexicalScope);
      return;
    case "BlockStatement":
      resolveStatements(node.body, node.scope, functionScope);
      return;
    case "IfStatement":
      resolveExpression(node.test, lexicalScope, functionScope);
      resolveStatement(node.consequent, lexicalScope, functionScope);
      if (node.alternate) {
        resolveStatement(node.alternate, lexicalScope, functionScope);
      }
      return;
    case "WhileStatement":
      resolveExpression(node.test, lexicalScope, functionScope);
      resolveStatement(node.body, lexicalScope, functionScope);
      return;
    case "DoWhileStatement":
      resolveStatement(node.body, lexicalScope, functionScope);
      resolveExpression(node.test, lexicalScope, functionScope);
      return;
    case "ForStatement": {
      const loopScope = node.scope;
      if (node.init) {
        if (node.init.type === "VariableDeclaration") {
          resolveStatement(node.init, loopScope, functionScope);
        } else {
          resolveExpression(node.init, loopScope, functionScope);
        }
      }
      if (node.test) {
        resolveExpression(node.test, loopScope, functionScope);
      }
      if (node.update) {
        resolveExpression(node.update, loopScope, functionScope);
      }
      resolveStatement(node.body, loopScope, functionScope);
      return;
    }
    case "ForInStatement":
    case "ForOfStatement": {
      const loopScope = node.scope;
      if (node.left.type === "VariableDeclaration") {
        resolveStatement(node.left, loopScope, functionScope);
      } else {
        resolvePatternReference(node.left, loopScope, functionScope);
      }
      resolveExpression(node.right, loopScope, functionScope);
      resolveStatement(node.body, loopScope, functionScope);
      return;
    }
    case "SwitchStatement":
      resolveExpression(node.discriminant, lexicalScope, functionScope);
      for (const switchCase of node.cases) {
        if (switchCase.test) {
          resolveExpression(switchCase.test, lexicalScope, functionScope);
        }
        resolveStatements(switchCase.consequent, lexicalScope, functionScope);
      }
      return;
    case "ReturnStatement":
    case "ThrowStatement":
      if (node.argument) {
        resolveExpression(node.argument, lexicalScope, functionScope);
      }
      return;
    case "TryStatement":
      resolveStatement(node.block, lexicalScope, functionScope);
      if (node.handler) {
        if (node.handler.param) {
          resolveBindingPattern(node.handler.param, node.handler.scope, functionScope);
        }
        resolveStatement(node.handler.body, node.handler.scope, functionScope);
      }
      if (node.finalizer) {
        resolveStatement(node.finalizer, lexicalScope, functionScope);
      }
      return;
    default:
      return;
  }
}

function resolveExpression(node, lexicalScope, functionScope) {
  if (!node) {
    return;
  }

  switch (node.type) {
    case "Literal":
    case "RegExpLiteral":
      return;
    case "Identifier":
      node.resolution = resolveName(lexicalScope, node.name);
      return;
    case "ThisExpression":
      node.resolution = createResolution(lexicalScope, functionScope.thisBinding);
      return;
    case "TemplateLiteral":
      for (const expression of node.expressions) {
        resolveExpression(expression, lexicalScope, functionScope);
      }
      return;
    case "ArrayExpression":
      for (const element of node.elements) {
        if (!element) {
          continue;
        }
        if (element.type === "SpreadElement") {
          resolveExpression(element.argument, lexicalScope, functionScope);
        } else {
          resolveExpression(element, lexicalScope, functionScope);
        }
      }
      return;
    case "ObjectExpression":
      for (const property of node.properties) {
        if (property.computed) {
          resolveExpression(property.key, lexicalScope, functionScope);
        }
        resolveExpression(property.value, lexicalScope, functionScope);
      }
      return;
    case "UnaryExpression":
    case "UpdateExpression":
      resolveExpression(node.argument, lexicalScope, functionScope);
      return;
    case "BinaryExpression":
    case "LogicalExpression":
      resolveExpression(node.left, lexicalScope, functionScope);
      resolveExpression(node.right, lexicalScope, functionScope);
      return;
    case "ConditionalExpression":
      resolveExpression(node.test, lexicalScope, functionScope);
      resolveExpression(node.consequent, lexicalScope, functionScope);
      resolveExpression(node.alternate, lexicalScope, functionScope);
      return;
    case "SequenceExpression":
      for (const expression of node.expressions) {
        resolveExpression(expression, lexicalScope, functionScope);
      }
      return;
    case "AssignmentExpression":
      if (node.left.type === "Identifier") {
        node.left.resolution = resolveName(lexicalScope, node.left.name);
      } else {
        resolveExpression(node.left, lexicalScope, functionScope);
      }
      resolveExpression(node.right, lexicalScope, functionScope);
      return;
    case "MemberExpression":
      resolveExpression(node.object, lexicalScope, functionScope);
      if (node.computed) {
        resolveExpression(node.property, lexicalScope, functionScope);
      }
      return;
    case "CallExpression":
      resolveExpression(node.callee, lexicalScope, functionScope);
      resolveArgumentList(node.arguments, lexicalScope, functionScope);
      return;
    case "NewExpression":
      resolveExpression(node.callee, lexicalScope, functionScope);
      resolveArgumentList(node.arguments, lexicalScope, functionScope);
      return;
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      resolveFunctionLike(node, lexicalScope);
      return;
    default:
      return;
  }
}

function resolveArgumentList(args, lexicalScope, functionScope) {
  for (const arg of args) {
    if (arg.type === "SpreadElement") {
      resolveExpression(arg.argument, lexicalScope, functionScope);
    } else {
      resolveExpression(arg, lexicalScope, functionScope);
    }
  }
}

function resolveFunctionLike(node, lexicalScope) {
  const functionScope = node.scope;

  if (node.type === "FunctionExpression" && node.id) {
    node.id.binding = createResolution(functionScope, functionScope.selfBinding);
  }

  for (const param of node.params) {
    resolveBindingPattern(param, functionScope, functionScope);
  }

  if (node.body.type === "BlockStatement") {
    resolveStatements(node.body.body, functionScope, functionScope);
    return;
  }

  resolveExpression(node.body, functionScope, functionScope);
}

function resolveBindingPattern(pattern, lexicalScope, functionScope) {
  switch (pattern.type) {
    case "Identifier":
      return;
    case "AssignmentPattern":
      resolveBindingPattern(pattern.left, lexicalScope, functionScope);
      resolveExpression(pattern.right, lexicalScope, functionScope);
      return;
    case "RestElement":
      resolveBindingPattern(pattern.argument, lexicalScope, functionScope);
      return;
    case "ArrayPattern":
      for (const element of pattern.elements) {
        if (element) {
          resolveBindingPattern(element, lexicalScope, functionScope);
        }
      }
      return;
    case "ObjectPattern":
      for (const property of pattern.properties) {
        if (property.computed) {
          resolveExpression(property.key, lexicalScope, functionScope);
        }
        resolveBindingPattern(property.value, lexicalScope, functionScope);
      }
      return;
    default:
      return;
  }
}

function resolvePatternReference(pattern, lexicalScope, functionScope) {
  switch (pattern.type) {
    case "Identifier":
      pattern.resolution = resolveName(lexicalScope, pattern.name);
      return;
    case "AssignmentPattern":
      resolvePatternReference(pattern.left, lexicalScope, functionScope);
      resolveExpression(pattern.right, lexicalScope, functionScope);
      return;
    case "RestElement":
      resolvePatternReference(pattern.argument, lexicalScope, functionScope);
      return;
    case "ArrayPattern":
      for (const element of pattern.elements) {
        if (element) {
          resolvePatternReference(element, lexicalScope, functionScope);
        }
      }
      return;
    case "ObjectPattern":
      for (const property of pattern.properties) {
        if (property.computed) {
          resolveExpression(property.key, lexicalScope, functionScope);
        }
        resolvePatternReference(property.value, lexicalScope, functionScope);
      }
      return;
    default:
      return;
  }
}

function resolveName(scope, name) {
  let current = scope;
  while (current) {
    const binding = current.bindingsByName.get(name);
    if (binding) {
      return createResolution(scope, binding);
    }
    current = current.parent;
  }
  return null;
}
