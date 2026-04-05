import { JSLiteRuntimeError } from "./errors.js";

const UNDECLARED = undefined;

export class Environment {
  constructor(parent = null, options = {}) {
    this.parent = parent;
    this.scope = options.scope ?? null;
    this.dynamicBindings = new Map();
    this.isFunctionScope = this.scope?.type === "function" || options.type === "function" || parent === null;
    this.functionScope = this.isFunctionScope ? this : (parent?.functionScope ?? this);
    this.ancestorCache = null;

    const slotCount = this.scope?.slotCount ?? 0;
    this.kinds = new Array(slotCount);
    this.values = new Array(slotCount);
  }

  createChild(type = "block") {
    return new Environment(this, { type });
  }

  createChildScope(scope) {
    return new Environment(this, { scope, type: scope.type });
  }

  initializeSlot(slot, kind, value) {
    this.kinds[slot] = kind;
    this.values[slot] = value;
    return value;
  }

  predeclareVarSlots(slots) {
    for (const slot of slots) {
      if (this.kinds[slot] === UNDECLARED) {
        this.kinds[slot] = "var";
        this.values[slot] = undefined;
      }
    }
  }

  declare(kind, name, value) {
    if (kind === "var") {
      return this.getFunctionScope().declareHere("var", name, value, true);
    }

    return this.declareHere(kind, name, value, false);
  }

  declareResolved(kind, resolution, value) {
    const scope = resolution.depth === 0 ? this : this.getAncestor(resolution.depth);
    return scope.declareHereResolved(kind, resolution.slot, resolution.name, value, kind === "var");
  }

  redeclare(name, kind, value) {
    const resolved = this.resolve(name);
    if (!resolved) {
      return this.declare(kind, name, value);
    }

    if (resolved.dynamic) {
      resolved.binding.kind = kind;
      resolved.binding.value = value;
      return value;
    }

    resolved.env.kinds[resolved.slot] = kind;
    resolved.env.values[resolved.slot] = value;
    return value;
  }

  redeclareResolved(kind, resolution, value) {
    const scope = resolution.depth === 0 ? this : this.getAncestor(resolution.depth);
    scope.kinds[resolution.slot] = kind;
    scope.values[resolution.slot] = value;
    return value;
  }

  declareHere(kind, name, value, allowRedeclare) {
    const slot = this.scope?.bindingsByName.get(name);
    if (slot) {
      return this.declareHereResolved(kind, slot.slot, name, value, allowRedeclare);
    }

    if (this.dynamicBindings.has(name)) {
      const existing = this.dynamicBindings.get(name);
      if (!allowRedeclare && existing.kind !== "var") {
        throw new JSLiteRuntimeError(`Identifier '${name}' has already been declared`);
      }
      if (allowRedeclare) {
        if (existing.kind !== "var") {
          throw new JSLiteRuntimeError(`Identifier '${name}' has already been declared`);
        }
        existing.value = value;
        existing.kind = kind;
        return value;
      }
    }

    this.dynamicBindings.set(name, { kind, value });
    return value;
  }

  declareHereResolved(kind, slot, name, value, allowRedeclare) {
    const existingKind = this.kinds[slot];

    if (existingKind !== UNDECLARED) {
      if (!allowRedeclare && existingKind !== "var") {
        throw new JSLiteRuntimeError(`Identifier '${name}' has already been declared`);
      }

      if (allowRedeclare) {
        if (existingKind !== "var") {
          throw new JSLiteRuntimeError(`Identifier '${name}' has already been declared`);
        }

        this.kinds[slot] = kind;
        this.values[slot] = value;
        return value;
      }
    }

    this.kinds[slot] = kind;
    this.values[slot] = value;
    return value;
  }

  assign(name, value) {
    const resolved = this.resolve(name);
    if (!resolved) {
      throw new JSLiteRuntimeError(`${name} is not defined`);
    }

    if (resolved.dynamic) {
      if (resolved.binding.kind === "const") {
        throw new JSLiteRuntimeError(`Assignment to constant variable '${name}'`);
      }
      resolved.binding.value = value;
      return value;
    }

    if (resolved.env.kinds[resolved.slot] === "const") {
      throw new JSLiteRuntimeError(`Assignment to constant variable '${name}'`);
    }

    resolved.env.values[resolved.slot] = value;
    return value;
  }

  assignResolved(resolution, value) {
    const scope = resolution.depth === 0 ? this : this.getAncestor(resolution.depth);
    const kind = scope.kinds[resolution.slot];

    if (kind === UNDECLARED) {
      throw new JSLiteRuntimeError(`${resolution.name} is not defined`);
    }

    if (kind === "const") {
      throw new JSLiteRuntimeError(`Assignment to constant variable '${resolution.name}'`);
    }

    scope.values[resolution.slot] = value;
    return value;
  }

  lookup(name) {
    const resolved = this.resolve(name);
    if (!resolved) {
      throw new JSLiteRuntimeError(`${name} is not defined`);
    }

    return resolved.dynamic
      ? resolved.binding.value
      : resolved.env.values[resolved.slot];
  }

  lookupResolved(resolution) {
    const scope = resolution.depth === 0 ? this : this.getAncestor(resolution.depth);
    const kind = scope.kinds[resolution.slot];

    if (kind === UNDECLARED) {
      throw new JSLiteRuntimeError(`${resolution.name} is not defined`);
    }

    return scope.values[resolution.slot];
  }

  has(name) {
    return Boolean(this.resolve(name));
  }

  hasResolved(resolution) {
    const scope = resolution.depth === 0 ? this : this.getAncestor(resolution.depth);
    return scope.kinds[resolution.slot] !== UNDECLARED;
  }

  resolve(name) {
    let scope = this;

    while (scope) {
      const slot = scope.scope?.bindingsByName.get(name);
      if (slot && scope.kinds[slot.slot] !== UNDECLARED) {
        return {
          env: scope,
          slot: slot.slot,
          dynamic: false,
        };
      }

      if (scope.dynamicBindings.has(name)) {
        return {
          env: scope,
          binding: scope.dynamicBindings.get(name),
          dynamic: true,
        };
      }

      scope = scope.parent;
    }

    return null;
  }

  getAncestor(depth) {
    if (depth === 0) {
      return this;
    }

    if (depth === 1) {
      if (!this.parent) {
        throw new JSLiteRuntimeError("Invalid scope resolution");
      }
      return this.parent;
    }

    if (this.ancestorCache && depth < this.ancestorCache.length) {
      const cached = this.ancestorCache[depth];
      if (!cached) {
        throw new JSLiteRuntimeError("Invalid scope resolution");
      }
      return cached;
    }

    const cache = this.ancestorCache ?? [this, this.parent ?? null];
    this.ancestorCache = cache;

    let scope = cache[cache.length - 1];
    while (cache.length <= depth && scope) {
      scope = scope.parent;
      cache.push(scope ?? null);
    }

    const resolved = cache[depth];
    if (!resolved) {
      throw new JSLiteRuntimeError("Invalid scope resolution");
    }

    return resolved;
  }

  getFunctionScope() {
    return this.functionScope ?? this;
  }
}
