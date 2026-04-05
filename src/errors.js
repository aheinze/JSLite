export class JSLiteError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class JSLiteSyntaxError extends JSLiteError {
  constructor(message, token = null) {
    const location = token ? ` at ${token.line}:${token.column}` : "";
    super(`${message}${location}`);
    this.token = token;
  }
}

export class JSLiteRuntimeError extends JSLiteError {}
