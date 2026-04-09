import { JSLiteSyntaxError } from "./errors.js";

const KEYWORDS = new Set([
  "var",
  "let",
  "const",
  "function",
  "return",
  "if",
  "else",
  "while",
  "for",
  "do",
  "break",
  "continue",
  "switch",
  "case",
  "default",
  "try",
  "catch",
  "finally",
  "throw",
  "true",
  "false",
  "null",
  "undefined",
  "typeof",
  "void",
  "delete",
  "in",
  "of",
  "instanceof",
  "new",
  "this",
]);

const MULTI_CHAR_TOKENS = [
  "...",
  ">>>=",
  ">>=",
  "<<=",
  "===",
  "!==",
  ">>>",
  ">>",
  "<<",
  "**=",
  "??=",
  "&=",
  "|=",
  "^=",
  "?.",
  "===",
  "!==",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "**",
  "++",
  "--",
  "=>",
];

const SINGLE_CHAR_TOKENS = new Set([
  "(",
  ")",
  "{",
  "}",
  "[",
  "]",
  ";",
  ",",
  ".",
  ":",
  "?",
  "+",
  "-",
  "*",
  "/",
  "%",
  "!",
  "=",
  "<",
  ">",
  "&",
  "|",
  "^",
  "~",
]);

export class Lexer {
  constructor(source) {
    this.source = source;
    this.length = source.length;
    this.index = 0;
    this.line = 1;
    this.column = 1;
    this.lastToken = null;
  }

  tokenize() {
    const tokens = [];

    while (!this.isAtEnd()) {
      this.skipWhitespaceAndComments();
      if (this.isAtEnd()) {
        break;
      }

      const token = this.readToken();
      tokens.push(token);
      this.lastToken = token;
    }

    tokens.push({
      type: "eof",
      value: "",
      line: this.line,
      column: this.column,
    });

    return tokens;
  }

  readToken() {
    const ch = this.peek();

    if (this.isDigit(ch)) {
      return this.readNumber();
    }

    if (ch === '"' || ch === "'") {
      return this.readString();
    }

    if (ch === "`") {
      return this.readTemplateLiteral();
    }

    if (ch === "/" && this.shouldReadRegex()) {
      return this.readRegularExpression();
    }

    if (this.isIdentifierStart(ch)) {
      return this.readIdentifierOrKeyword();
    }

    return this.readOperatorOrPunctuation();
  }

  readNumber() {
    const line = this.line;
    const column = this.column;
    let value = "";

    if (this.peek() === "0") {
      const next = this.peek(1);

      if (next === "x" || next === "X") {
        value += this.advance() + this.advance();
        if (!this.isHexDigit(this.peek())) {
          throw new JSLiteSyntaxError("Expected hex digit after 0x", { line, column });
        }
        while (!this.isAtEnd() && this.isHexDigit(this.peek())) {
          value += this.advance();
        }
        return { type: "number", value, line, column };
      }

      if (next === "b" || next === "B") {
        value += this.advance() + this.advance();
        if (this.peek() !== "0" && this.peek() !== "1") {
          throw new JSLiteSyntaxError("Expected binary digit after 0b", { line, column });
        }
        while (!this.isAtEnd() && (this.peek() === "0" || this.peek() === "1")) {
          value += this.advance();
        }
        return { type: "number", value, line, column };
      }

      if (next === "o" || next === "O") {
        value += this.advance() + this.advance();
        if (this.peek() < "0" || this.peek() > "7") {
          throw new JSLiteSyntaxError("Expected octal digit after 0o", { line, column });
        }
        while (!this.isAtEnd() && this.peek() >= "0" && this.peek() <= "7") {
          value += this.advance();
        }
        return { type: "number", value, line, column };
      }
    }

    let sawDot = false;

    while (!this.isAtEnd()) {
      const ch = this.peek();

      if (this.isDigit(ch)) {
        value += this.advance();
        continue;
      }

      if (ch === "." && !sawDot && this.isDigit(this.peek(1))) {
        sawDot = true;
        value += this.advance();
        continue;
      }

      break;
    }

    if (!this.isAtEnd() && (this.peek() === "e" || this.peek() === "E")) {
      value += this.advance();
      if (!this.isAtEnd() && (this.peek() === "+" || this.peek() === "-")) {
        value += this.advance();
      }
      if (this.isAtEnd() || !this.isDigit(this.peek())) {
        throw new JSLiteSyntaxError("Expected digit in exponent", { line, column });
      }
      while (!this.isAtEnd() && this.isDigit(this.peek())) {
        value += this.advance();
      }
    }

    return { type: "number", value, line, column };
  }

  readString() {
    const quote = this.advance();
    const line = this.line;
    const column = this.column - 1;
    let value = "";

    while (!this.isAtEnd()) {
      const ch = this.advance();

      if (ch === quote) {
        return { type: "string", value, line, column };
      }

      if (ch === "\\") {
        if (this.isAtEnd()) {
          throw new JSLiteSyntaxError("Unterminated string escape");
        }

        value += this.readEscapeSequence(false);
        continue;
      }

      if (ch === "\n") {
        throw new JSLiteSyntaxError("Unterminated string literal", {
          line,
          column,
        });
      }

      value += ch;
    }

    throw new JSLiteSyntaxError("Unterminated string literal", {
      line,
      column,
    });
  }

  readTemplateLiteral() {
    this.advance();
    const line = this.line;
    const column = this.column - 1;
    const quasis = [];
    const expressions = [];
    let current = "";

    while (!this.isAtEnd()) {
      const ch = this.advance();

      if (ch === "`") {
        quasis.push(current);
        return {
          type: "template",
          value: { quasis, expressions },
          line,
          column,
        };
      }

      if (ch === "\\") {
        if (this.isAtEnd()) {
          throw new JSLiteSyntaxError("Unterminated template literal", {
            line,
            column,
          });
        }

        current += this.readEscapeSequence(true);
        continue;
      }

      if (ch === "$" && this.peek() === "{") {
        this.advance();
        quasis.push(current);
        current = "";
        expressions.push(this.readTemplateExpressionSource(line, column));
        continue;
      }

      current += ch;
    }

    throw new JSLiteSyntaxError("Unterminated template literal", {
      line,
      column,
    });
  }

  readTemplateExpressionSource(templateLine, templateColumn) {
    let depth = 1;
    let source = "";

    while (!this.isAtEnd()) {
      const ch = this.advance();

      if (ch === "'" || ch === '"') {
        source += ch;
        source += this.readRawQuotedSegment(ch);
        continue;
      }

      if (ch === "`") {
        source += "`";
        source += this.readRawTemplateLiteral();
        continue;
      }

      if (ch === "/" && this.peek() === "/") {
        source += ch;
        source += this.readRawLineComment();
        continue;
      }

      if (ch === "/" && this.peek() === "*") {
        source += ch;
        source += this.readRawBlockComment();
        continue;
      }

      if (ch === "\\") {
        source += ch;
        if (!this.isAtEnd()) {
          source += this.advance();
        }
        continue;
      }

      if (ch === "{") {
        depth += 1;
        source += ch;
        continue;
      }

      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          return source;
        }
        source += ch;
        continue;
      }

      source += ch;
    }

    throw new JSLiteSyntaxError("Unterminated template literal interpolation", {
      line: templateLine,
      column: templateColumn,
    });
  }

  readRawQuotedSegment(quote) {
    let raw = "";

    while (!this.isAtEnd()) {
      const ch = this.advance();
      raw += ch;

      if (ch === "\\") {
        if (this.isAtEnd()) {
          break;
        }
        raw += this.advance();
        continue;
      }

      if (ch === quote) {
        return raw;
      }
    }

    return raw;
  }

  readRawTemplateLiteral() {
    let raw = "";

    while (!this.isAtEnd()) {
      const ch = this.advance();
      raw += ch;

      if (ch === "\\") {
        if (!this.isAtEnd()) {
          raw += this.advance();
        }
        continue;
      }

      if (ch === "$" && this.peek() === "{") {
        raw += this.advance();
        raw += this.readTemplateExpressionSource(this.line, this.column);
        raw += "}";
        continue;
      }

      if (ch === "`") {
        return raw;
      }
    }

    return raw;
  }

  readRawLineComment() {
    let raw = this.advance();
    while (!this.isAtEnd() && this.peek() !== "\n") {
      raw += this.advance();
    }
    return raw;
  }

  readRawBlockComment() {
    let raw = this.advance();
    while (!this.isAtEnd() && !this.source.startsWith("*/", this.index)) {
      raw += this.advance();
    }
    if (this.isAtEnd()) {
      return raw;
    }
    raw += this.advance();
    raw += this.advance();
    return raw;
  }

  readRegularExpression() {
    const line = this.line;
    const column = this.column;
    this.advance();
    let pattern = "";
    let inCharacterClass = false;

    while (!this.isAtEnd()) {
      const ch = this.advance();

      if (ch === "\\") {
        pattern += ch;
        if (this.isAtEnd()) {
          throw new JSLiteSyntaxError("Unterminated regular expression literal", {
            line,
            column,
          });
        }
        pattern += this.advance();
        continue;
      }

      if (ch === "\n") {
        throw new JSLiteSyntaxError("Unterminated regular expression literal", {
          line,
          column,
        });
      }

      if (ch === "[" && !inCharacterClass) {
        inCharacterClass = true;
        pattern += ch;
        continue;
      }

      if (ch === "]" && inCharacterClass) {
        inCharacterClass = false;
        pattern += ch;
        continue;
      }

      if (ch === "/" && !inCharacterClass) {
        let flags = "";
        while (!this.isAtEnd() && /[A-Za-z]/.test(this.peek())) {
          flags += this.advance();
        }

        return {
          type: "regex",
          value: { pattern, flags },
          line,
          column,
        };
      }

      pattern += ch;
    }

    throw new JSLiteSyntaxError("Unterminated regular expression literal", {
      line,
      column,
    });
  }

  readIdentifierOrKeyword() {
    const line = this.line;
    const column = this.column;
    let value = "";

    while (!this.isAtEnd() && this.isIdentifierPart(this.peek())) {
      value += this.advance();
    }

    return {
      type: KEYWORDS.has(value) ? "keyword" : "identifier",
      value,
      line,
      column,
    };
  }

  readOperatorOrPunctuation() {
    const line = this.line;
    const column = this.column;

    for (const candidate of MULTI_CHAR_TOKENS) {
      if (this.source.startsWith(candidate, this.index)) {
        this.advanceBy(candidate.length);
        return {
          type: "operator",
          value: candidate,
          line,
          column,
        };
      }
    }

    const ch = this.advance();
    if (!SINGLE_CHAR_TOKENS.has(ch)) {
      throw new JSLiteSyntaxError(`Unexpected character '${ch}'`, {
        line,
        column,
      });
    }

    return {
      type: ch === "." || ch === "," || ch === ";" || ch === ":" || ch === "?" || ch === "(" || ch === ")" || ch === "{" || ch === "}" || ch === "[" || ch === "]"
        ? "punctuation"
        : "operator",
      value: ch,
      line,
      column,
    };
  }

  skipWhitespaceAndComments() {
    let advanced = true;

    while (advanced && !this.isAtEnd()) {
      advanced = false;

      while (!this.isAtEnd()) {
        const ch = this.peek();
        if (ch === " " || ch === "\t" || ch === "\r") {
          this.advance();
          advanced = true;
          continue;
        }
        if (ch === "\n") {
          this.advance();
          advanced = true;
          continue;
        }
        break;
      }

      if (this.source.startsWith("//", this.index)) {
        advanced = true;
        while (!this.isAtEnd() && this.peek() !== "\n") {
          this.advance();
        }
        continue;
      }

      if (this.source.startsWith("/*", this.index)) {
        advanced = true;
        this.advanceBy(2);
        while (!this.isAtEnd() && !this.source.startsWith("*/", this.index)) {
          this.advance();
        }
        if (this.isAtEnd()) {
          throw new JSLiteSyntaxError("Unterminated block comment", {
            line: this.line,
            column: this.column,
          });
        }
        this.advanceBy(2);
      }
    }
  }

  decodeEscape(ch) {
    switch (ch) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "\\":
        return "\\";
      case "'":
        return "'";
      case '"':
        return '"';
      case "0":
        return "\0";
      default:
        return ch;
    }
  }

  readEscapeSequence(isTemplate) {
    const escaped = this.advance();

    if (isTemplate) {
      if (escaped === "`") {
        return "`";
      }
      if (escaped === "$") {
        return "$";
      }
    }

    if (escaped === "x") {
      return this.readHexEscape(2);
    }

    if (escaped === "u") {
      return this.readHexEscape(4);
    }

    return this.decodeEscape(escaped);
  }

  readHexEscape(length) {
    let hex = "";

    for (let index = 0; index < length; index += 1) {
      if (this.isAtEnd()) {
        throw new JSLiteSyntaxError("Unterminated string escape");
      }

      const ch = this.advance();
      if (!/[0-9a-fA-F]/.test(ch)) {
        throw new JSLiteSyntaxError("Invalid hexadecimal escape sequence", {
          line: this.line,
          column: this.column - 1,
        });
      }

      hex += ch;
    }

    return String.fromCodePoint(Number.parseInt(hex, 16));
  }

  shouldReadRegex() {
    const token = this.lastToken;
    if (!token) {
      return true;
    }

    if (token.type === "number" || token.type === "string" || token.type === "identifier" || token.type === "regex" || token.type === "template") {
      return false;
    }

    if (token.type === "keyword") {
      return !(
        token.value === "true" ||
        token.value === "false" ||
        token.value === "null" ||
        token.value === "undefined" ||
        token.value === "this"
      );
    }

    if (token.type === "punctuation") {
      return token.value !== ")" && token.value !== "]" && token.value !== "}";
    }

    if (token.type === "operator") {
      return token.value !== "++" && token.value !== "--";
    }

    return true;
  }

  isIdentifierStart(ch) {
    return /[A-Za-z_$]/.test(ch);
  }

  isIdentifierPart(ch) {
    return /[A-Za-z0-9_$]/.test(ch);
  }

  isDigit(ch) {
    return /[0-9]/.test(ch);
  }

  isHexDigit(ch) {
    return /[0-9a-fA-F]/.test(ch);
  }

  isAtEnd() {
    return this.index >= this.length;
  }

  peek(offset = 0) {
    return this.source[this.index + offset] ?? "\0";
  }

  advance() {
    const ch = this.source[this.index++];
    if (ch === "\n") {
      this.line += 1;
      this.column = 1;
    } else {
      this.column += 1;
    }
    return ch;
  }

  advanceBy(count) {
    for (let i = 0; i < count; i += 1) {
      this.advance();
    }
  }
}
