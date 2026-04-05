import { JSLiteSyntaxError } from "./errors.js";
import { Lexer } from "./lexer.js";

export class Parser {
  constructor(source) {
    this.tokens = new Lexer(source).tokenize();
    this.index = 0;
  }

  parse() {
    const body = [];
    while (!this.is("eof")) {
      body.push(this.parseStatement());
    }

    return {
      type: "Program",
      body,
    };
  }

  parseStatement() {
    if (this.matchValue(";")) {
      throw this.error("Empty statements are not supported");
    }

    if (this.isKeyword("var") || this.isKeyword("let") || this.isKeyword("const")) {
      return this.parseVariableDeclaration(true);
    }

    if (this.isKeyword("function")) {
      return this.parseFunctionDeclaration();
    }

    if (this.isKeyword("if")) {
      return this.parseIfStatement();
    }

    if (this.isKeyword("while")) {
      return this.parseWhileStatement();
    }

    if (this.isKeyword("for")) {
      return this.parseForStatement();
    }

    if (this.isKeyword("do")) {
      return this.parseDoWhileStatement();
    }

    if (this.isKeyword("switch")) {
      return this.parseSwitchStatement();
    }

    if (this.isKeyword("try")) {
      return this.parseTryStatement();
    }

    if (this.isKeyword("return")) {
      return this.parseReturnStatement();
    }

    if (this.isKeyword("throw")) {
      return this.parseThrowStatement();
    }

    if (this.isKeyword("break")) {
      this.advance();
      this.consumeSemicolon();
      return { type: "BreakStatement" };
    }

    if (this.isKeyword("continue")) {
      this.advance();
      this.consumeSemicolon();
      return { type: "ContinueStatement" };
    }

    if (this.matchValue("{")) {
      return this.finishBlockStatement();
    }

    const expression = this.parseExpression();
    this.consumeSemicolon();
    return {
      type: "ExpressionStatement",
      expression,
    };
  }

  parseVariableDeclaration(expectSemicolon, allowMissingInitializer = false) {
    const kind = this.expectType("keyword").value;
    const declarations = [];

    do {
      const id = this.parseBindingPattern();
      let init = null;

      if (this.matchValue("=")) {
        init = this.parseAssignmentExpression();
      } else if (kind === "const" && !allowMissingInitializer) {
        throw this.error("const declarations must be initialized");
      }

      declarations.push({
        type: "VariableDeclarator",
        id,
        init,
      });
    } while (this.matchValue(","));

    if (expectSemicolon) {
      this.consumeSemicolon();
    }

    return {
      type: "VariableDeclaration",
      kind,
      declarations,
    };
  }

  parseFunctionDeclaration() {
    this.expectKeyword("function");
    const id = this.parseIdentifier();
    const params = this.parseParameterList();
    const body = this.parseBlockStatement();

    return {
      type: "FunctionDeclaration",
      id,
      params,
      body,
    };
  }

  parseIfStatement() {
    this.expectKeyword("if");
    this.expectValue("(");
    const test = this.parseExpression();
    this.expectValue(")");
    const consequent = this.parseStatement();
    const alternate = this.matchKeyword("else") ? this.parseStatement() : null;

    return {
      type: "IfStatement",
      test,
      consequent,
      alternate,
    };
  }

  parseWhileStatement() {
    this.expectKeyword("while");
    this.expectValue("(");
    const test = this.parseExpression();
    this.expectValue(")");
    const body = this.parseStatement();

    return {
      type: "WhileStatement",
      test,
      body,
    };
  }

  parseDoWhileStatement() {
    this.expectKeyword("do");
    const body = this.parseStatement();
    this.expectKeyword("while");
    this.expectValue("(");
    const test = this.parseExpression();
    this.expectValue(")");
    this.consumeSemicolon();

    return {
      type: "DoWhileStatement",
      body,
      test,
    };
  }

  parseForStatement() {
    this.expectKeyword("for");
    this.expectValue("(");

    let init = null;
    if (!this.matchValue(";")) {
      if (this.isKeyword("var") || this.isKeyword("let") || this.isKeyword("const")) {
        init = this.parseVariableDeclaration(false, true);
      } else {
        init = this.parseExpression(true);
      }

      if (this.matchKeyword("in")) {
        const right = this.parseExpression();
        this.expectValue(")");
        return {
          type: "ForInStatement",
          left: init,
          right,
          body: this.parseStatement(),
        };
      }

      if (this.matchKeyword("of")) {
        const right = this.parseExpression();
        this.expectValue(")");
        return {
          type: "ForOfStatement",
          left: init,
          right,
          body: this.parseStatement(),
        };
      }

      this.expectValue(";");
    }

    let test = null;
    if (!this.matchValue(";")) {
      test = this.parseExpression(true);
      this.expectValue(";");
    }

    let update = null;
    if (!this.matchValue(")")) {
      update = this.parseExpression(true);
      this.expectValue(")");
    }

    const body = this.parseStatement();
    return {
      type: "ForStatement",
      init,
      test,
      update,
      body,
    };
  }

  parseSwitchStatement() {
    this.expectKeyword("switch");
    this.expectValue("(");
    const discriminant = this.parseExpression();
    this.expectValue(")");
    this.expectValue("{");

    const cases = [];
    while (!this.isValue("}") && !this.is("eof")) {
      if (this.matchKeyword("case")) {
        const test = this.parseExpression();
        this.expectValue(":");
        const consequent = [];
        while (
          !this.isValue("}") &&
          !this.isKeyword("case") &&
          !this.isKeyword("default") &&
          !this.is("eof")
        ) {
          consequent.push(this.parseStatement());
        }
        cases.push({ type: "SwitchCase", test, consequent });
        continue;
      }

      if (this.matchKeyword("default")) {
        this.expectValue(":");
        const consequent = [];
        while (
          !this.isValue("}") &&
          !this.isKeyword("case") &&
          !this.isKeyword("default") &&
          !this.is("eof")
        ) {
          consequent.push(this.parseStatement());
        }
        cases.push({ type: "SwitchCase", test: null, consequent });
        continue;
      }

      throw this.error("Expected 'case' or 'default'");
    }

    this.expectValue("}");
    return {
      type: "SwitchStatement",
      discriminant,
      cases,
    };
  }

  parseTryStatement() {
    this.expectKeyword("try");
    const block = this.parseBlockStatement();
    let handler = null;
    let finalizer = null;

    if (this.matchKeyword("catch")) {
      let param = null;
      if (this.matchValue("(")) {
        param = this.parseIdentifier();
        this.expectValue(")");
      }
      handler = {
        type: "CatchClause",
        param,
        body: this.parseBlockStatement(),
      };
    }

    if (this.matchKeyword("finally")) {
      finalizer = this.parseBlockStatement();
    }

    if (!handler && !finalizer) {
      throw this.error("Missing catch or finally after try");
    }

    return {
      type: "TryStatement",
      block,
      handler,
      finalizer,
    };
  }

  parseReturnStatement() {
    this.expectKeyword("return");
    let argument = null;
    if (!this.isValue(";") && !this.isValue("}") && !this.is("eof")) {
      argument = this.parseExpression();
    }
    this.consumeSemicolon();

    return {
      type: "ReturnStatement",
      argument,
    };
  }

  parseThrowStatement() {
    this.expectKeyword("throw");
    const argument = this.parseExpression();
    this.consumeSemicolon();
    return {
      type: "ThrowStatement",
      argument,
    };
  }

  parseBlockStatement() {
    this.expectValue("{");
    return this.finishBlockStatement();
  }

  finishBlockStatement() {
    const body = [];
    while (!this.isValue("}") && !this.is("eof")) {
      body.push(this.parseStatement());
    }
    this.expectValue("}");

    return {
      type: "BlockStatement",
      body,
    };
  }

  parseParameterList() {
    this.expectValue("(");
    return this.parseParametersAfterOpenParen();
  }

  parseExpression(allowSequence = false) {
    return allowSequence
      ? this.parseSequenceExpression()
      : this.parseAssignmentExpression();
  }

  parseSequenceExpression() {
    const expressions = [this.parseAssignmentExpression()];

    while (this.matchValue(",")) {
      expressions.push(this.parseAssignmentExpression());
    }

    return expressions.length === 1
      ? expressions[0]
      : {
          type: "SequenceExpression",
          expressions,
        };
  }

  parseAssignmentExpression() {
    const arrow = this.tryParseArrowFunction();
    if (arrow) {
      return arrow;
    }

    const left = this.parseConditionalExpression();
    if (!this.isAssignmentOperator(this.current().value)) {
      return left;
    }

    const operator = this.advance().value;
    if (left.type !== "Identifier" && left.type !== "MemberExpression") {
      throw this.error("Invalid assignment target");
    }

    return {
      type: "AssignmentExpression",
      operator,
      left,
      right: this.parseAssignmentExpression(),
    };
  }

  tryParseArrowFunction() {
    const start = this.index;

    try {
      let params = null;

      if (this.is("identifier") && this.peek(1)?.value === "=>") {
        params = [this.parseIdentifier()];
        this.expectValue("=>");
      } else if (this.matchValue("(")) {
        params = this.parseParametersAfterOpenParen();

        if (!this.matchValue("=>")) {
          this.index = start;
          return null;
        }
      } else {
        return null;
      }

      let body;
      let expression = false;
      if (this.isValue("{")) {
        body = this.parseBlockStatement();
      } else {
        body = this.parseAssignmentExpression();
        expression = true;
      }

      return {
        type: "ArrowFunctionExpression",
        params,
        body,
        expression,
      };
    } catch {
      this.index = start;
      return null;
    }
  }

  parseConditionalExpression() {
    const test = this.parseNullishExpression();
    if (!this.matchValue("?")) {
      return test;
    }

    const consequent = this.parseAssignmentExpression();
    this.expectValue(":");
    const alternate = this.parseAssignmentExpression();

    return {
      type: "ConditionalExpression",
      test,
      consequent,
      alternate,
    };
  }

  parseNullishExpression() {
    let left = this.parseLogicalOrExpression();
    while (this.matchValue("??")) {
      left = {
        type: "LogicalExpression",
        operator: "??",
        left,
        right: this.parseLogicalOrExpression(),
      };
    }
    return left;
  }

  parseLogicalOrExpression() {
    let left = this.parseLogicalAndExpression();
    while (this.matchValue("||")) {
      left = {
        type: "LogicalExpression",
        operator: "||",
        left,
        right: this.parseLogicalAndExpression(),
      };
    }
    return left;
  }

  parseLogicalAndExpression() {
    let left = this.parseBitwiseOrExpression();
    while (this.matchValue("&&")) {
      left = {
        type: "LogicalExpression",
        operator: "&&",
        left,
        right: this.parseBitwiseOrExpression(),
      };
    }
    return left;
  }

  parseBitwiseOrExpression() {
    let left = this.parseBitwiseXorExpression();
    while (this.matchValue("|")) {
      left = {
        type: "BinaryExpression",
        operator: "|",
        left,
        right: this.parseBitwiseXorExpression(),
      };
    }
    return left;
  }

  parseBitwiseXorExpression() {
    let left = this.parseBitwiseAndExpression();
    while (this.matchValue("^")) {
      left = {
        type: "BinaryExpression",
        operator: "^",
        left,
        right: this.parseBitwiseAndExpression(),
      };
    }
    return left;
  }

  parseBitwiseAndExpression() {
    let left = this.parseEqualityExpression();
    while (this.matchValue("&")) {
      left = {
        type: "BinaryExpression",
        operator: "&",
        left,
        right: this.parseEqualityExpression(),
      };
    }
    return left;
  }

  parseEqualityExpression() {
    let left = this.parseComparisonExpression();
    while (this.isValue("==") || this.isValue("!=") || this.isValue("===") || this.isValue("!==")) {
      const operator = this.advance().value;
      left = {
        type: "BinaryExpression",
        operator,
        left,
        right: this.parseComparisonExpression(),
      };
    }
    return left;
  }

  parseComparisonExpression() {
    let left = this.parseShiftExpression();
    while (
      this.isValue("<") ||
      this.isValue("<=") ||
      this.isValue(">") ||
      this.isValue(">=") ||
      this.isKeyword("in") ||
      this.isKeyword("instanceof")
    ) {
      const operator = this.advance().value;
      left = {
        type: "BinaryExpression",
        operator,
        left,
        right: this.parseShiftExpression(),
      };
    }
    return left;
  }

  parseShiftExpression() {
    let left = this.parseAdditiveExpression();
    while (this.isValue("<<") || this.isValue(">>") || this.isValue(">>>")) {
      const operator = this.advance().value;
      left = {
        type: "BinaryExpression",
        operator,
        left,
        right: this.parseAdditiveExpression(),
      };
    }
    return left;
  }

  parseAdditiveExpression() {
    let left = this.parseMultiplicativeExpression();
    while (this.isValue("+") || this.isValue("-")) {
      const operator = this.advance().value;
      left = {
        type: "BinaryExpression",
        operator,
        left,
        right: this.parseMultiplicativeExpression(),
      };
    }
    return left;
  }

  parseMultiplicativeExpression() {
    let left = this.parseExponentiationExpression();
    while (this.isValue("*") || this.isValue("/") || this.isValue("%")) {
      const operator = this.advance().value;
      left = {
        type: "BinaryExpression",
        operator,
        left,
        right: this.parseExponentiationExpression(),
      };
    }
    return left;
  }

  parseExponentiationExpression() {
    const left = this.parseUnaryExpression();
    if (!this.matchValue("**")) {
      return left;
    }

    return {
      type: "BinaryExpression",
      operator: "**",
      left,
      right: this.parseExponentiationExpression(),
    };
  }

  parseUnaryExpression() {
    if (
      this.isValue("!") ||
      this.isValue("-") ||
      this.isValue("~") ||
      this.isValue("++") ||
      this.isValue("--")
    ) {
      const operator = this.advance().value;
      return {
        type: operator === "++" || operator === "--" ? "UpdateExpression" : "UnaryExpression",
        operator,
        prefix: true,
        argument: this.parseUnaryExpression(),
      };
    }

    if (this.isValue("+")) {
      throw this.error("Unary '+' is not supported");
    }

    if (
      this.isKeyword("typeof") ||
      this.isKeyword("void") ||
      this.isKeyword("delete")
    ) {
      const operator = this.advance().value;
      return {
        type: "UnaryExpression",
        operator,
        argument: this.parseUnaryExpression(),
      };
    }

    return this.parseUpdateExpression();
  }

  parseNewExpression() {
    this.expectKeyword("new");
    let callee = this.isKeyword("new")
      ? this.parseNewExpression()
      : this.parsePrimaryExpression();
    callee = this.parseMemberExpressionTail(callee);

    let args = [];
    if (this.matchValue("(")) {
      args = this.parseArgumentListAfterOpenParen();
    }

    return {
      type: "NewExpression",
      callee,
      arguments: args,
    };
  }

  parseUpdateExpression() {
    const expression = this.parseCallMemberExpression();
    if (this.isValue("++") || this.isValue("--")) {
      return {
        type: "UpdateExpression",
        operator: this.advance().value,
        argument: expression,
        prefix: false,
      };
    }
    return expression;
  }

  parseCallMemberExpression() {
    let expression = this.isKeyword("new")
      ? this.parseNewExpression()
      : this.parsePrimaryExpression();
    return this.parseCallMemberExpressionTail(expression);
  }

  parseMemberExpressionTail(expression) {
    while (true) {
      if (this.matchValue(".")) {
        expression = {
          type: "MemberExpression",
          object: expression,
          property: this.parseIdentifierName(),
          computed: false,
          optional: false,
          chain: Boolean(expression.chain),
        };
        continue;
      }

      if (this.matchValue("[")) {
        const property = this.parseExpression();
        this.expectValue("]");
        expression = {
          type: "MemberExpression",
          object: expression,
          property,
          computed: true,
          optional: false,
          chain: Boolean(expression.chain),
        };
        continue;
      }

      break;
    }

    return expression;
  }

  parseCallMemberExpressionTail(expression) {
    while (true) {
      if (this.matchValue("?.")) {
        if (this.matchValue("(")) {
          expression = {
            type: "CallExpression",
            callee: expression,
            arguments: this.parseArgumentListAfterOpenParen(),
            optional: true,
            chain: true,
          };
          continue;
        }

        if (this.matchValue("[")) {
          const property = this.parseExpression();
          this.expectValue("]");
          expression = {
            type: "MemberExpression",
            object: expression,
            property,
            computed: true,
            optional: true,
            chain: true,
          };
          continue;
        }

        expression = {
          type: "MemberExpression",
          object: expression,
          property: this.parseIdentifierName(),
          computed: false,
          optional: true,
          chain: true,
        };
        continue;
      }

      if (this.matchValue("(")) {
        expression = {
          type: "CallExpression",
          callee: expression,
          arguments: this.parseArgumentListAfterOpenParen(),
          optional: false,
          chain: Boolean(expression.chain),
        };
        continue;
      }

      if (this.isValue(".") || this.isValue("[")) {
        expression = this.parseMemberExpressionTail(expression);
        continue;
      }

      break;
    }

    return expression;
  }

  parsePrimaryExpression() {
    const token = this.current();

    if (token.type === "number") {
      this.advance();
      return {
        type: "Literal",
        value: Number(token.value),
      };
    }

    if (token.type === "string") {
      this.advance();
      return {
        type: "Literal",
        value: token.value,
      };
    }

    if (token.type === "template") {
      this.advance();
      return {
        type: "TemplateLiteral",
        quasis: token.value.quasis,
        expressions: token.value.expressions.map((source) => parseEmbeddedExpressionSource(source)),
      };
    }

    if (token.type === "regex") {
      this.advance();
      return {
        type: "RegExpLiteral",
        pattern: token.value.pattern,
        flags: token.value.flags,
      };
    }

    if (token.type === "identifier") {
      return this.parseIdentifier();
    }

    if (token.type === "keyword") {
      if (token.value === "true" || token.value === "false") {
        this.advance();
        return {
          type: "Literal",
          value: token.value === "true",
        };
      }

      if (token.value === "null") {
        this.advance();
        return {
          type: "Literal",
          value: null,
        };
      }

      if (token.value === "undefined") {
        this.advance();
        return {
          type: "Literal",
          value: undefined,
        };
      }

      if (token.value === "this") {
        this.advance();
        return {
          type: "ThisExpression",
        };
      }

      if (token.value === "function") {
        return this.parseFunctionExpression();
      }
    }

    if (this.matchValue("(")) {
      const expression = this.parseExpression();
      this.expectValue(")");
      return expression;
    }

    if (this.matchValue("[")) {
      return this.parseArrayExpression();
    }

    if (this.matchValue("{")) {
      return this.parseObjectExpression();
    }

    throw this.error(`Unexpected token '${token.value}'`);
  }

  parseArrayExpression() {
    const elements = [];
    if (!this.matchValue("]")) {
      do {
        if (this.matchValue("...")) {
          elements.push({
            type: "SpreadElement",
            argument: this.parseAssignmentExpression(),
          });
        } else {
          elements.push(this.parseAssignmentExpression());
        }
      } while (this.matchValue(",") && !this.isValue("]"));
      this.expectValue("]");
    }

    return {
      type: "ArrayExpression",
      elements,
    };
  }

  parseObjectExpression() {
    const properties = [];

    if (!this.matchValue("}")) {
      do {
        const keyToken = this.current();
        let key = null;

        if (keyToken.type === "identifier" || keyToken.type === "keyword") {
          key = keyToken.value;
          this.advance();
          if (this.matchValue(":")) {
            properties.push({
              type: "Property",
              key,
              computed: false,
              value: this.parseAssignmentExpression(),
            });
          } else if (keyToken.type === "identifier") {
            properties.push({
              type: "Property",
              key,
              computed: false,
              value: {
                type: "Identifier",
                name: key,
              },
            });
          } else {
            throw this.error("Invalid object key");
          }
        } else if (keyToken.type === "string" || keyToken.type === "number") {
          key = String(keyToken.type === "number" ? Number(keyToken.value) : keyToken.value);
          this.advance();
          this.expectValue(":");
          properties.push({
            type: "Property",
            key,
            computed: false,
            value: this.parseAssignmentExpression(),
          });
        } else if (this.matchValue("[")) {
          key = this.parseExpression();
          this.expectValue("]");
          this.expectValue(":");
          properties.push({
            type: "Property",
            key,
            computed: true,
            value: this.parseAssignmentExpression(),
          });
        } else {
          throw this.error("Invalid object key");
        }
      } while (this.matchValue(",") && !this.isValue("}"));

      this.expectValue("}");
    }

    return {
      type: "ObjectExpression",
      properties,
    };
  }

  parseFunctionExpression() {
    this.expectKeyword("function");
    const id = this.is("identifier") ? this.parseIdentifier() : null;
    const params = this.parseParameterList();
    const body = this.parseBlockStatement();

    return {
      type: "FunctionExpression",
      id,
      params,
      body,
    };
  }

  parseArgumentListAfterOpenParen() {
    const args = [];
    if (!this.matchValue(")")) {
      do {
        if (this.matchValue("...")) {
          args.push({
            type: "SpreadElement",
            argument: this.parseAssignmentExpression(),
          });
        } else {
          args.push(this.parseAssignmentExpression());
        }
      } while (this.matchValue(","));
      this.expectValue(")");
    }
    return args;
  }

  parseParametersAfterOpenParen() {
    const params = [];

    if (!this.matchValue(")")) {
      do {
        if (this.matchValue("...")) {
          params.push({
            type: "RestElement",
            argument: this.parseBindingPattern(),
          });
          break;
        }

        params.push(this.parseBindingElement());
      } while (this.matchValue(","));

      this.expectValue(")");
    }

    return params;
  }

  parseBindingElement() {
    const binding = this.parseBindingPattern();

    if (!this.matchValue("=")) {
      return binding;
    }

    return {
      type: "AssignmentPattern",
      left: binding,
      right: this.parseAssignmentExpression(),
    };
  }

  parseBindingPattern() {
    if (this.isValue("[")) {
      return this.parseArrayPattern();
    }

    if (this.isValue("{")) {
      return this.parseObjectPattern();
    }

    return this.parseIdentifier();
  }

  parseArrayPattern() {
    this.expectValue("[");
    const elements = [];

    while (!this.isValue("]") && !this.is("eof")) {
      if (this.matchValue(",")) {
        elements.push(null);
        continue;
      }

      if (this.matchValue("...")) {
        elements.push({
          type: "RestElement",
          argument: this.parseBindingPattern(),
        });
        break;
      }

      elements.push(this.parseBindingElement());

      if (!this.matchValue(",")) {
        break;
      }
    }

    this.expectValue("]");
    return {
      type: "ArrayPattern",
      elements,
    };
  }

  parseObjectPattern() {
    this.expectValue("{");
    const properties = [];

    if (!this.matchValue("}")) {
      do {
        let key;
        let computed = false;
        let value;
        const keyToken = this.current();

        if (keyToken.type === "identifier" || keyToken.type === "keyword") {
          key = keyToken.value;
          this.advance();

          if (this.matchValue(":")) {
            value = this.parseBindingElement();
          } else if (keyToken.type === "identifier") {
            value = {
              type: "Identifier",
              name: key,
            };

            if (this.matchValue("=")) {
              value = {
                type: "AssignmentPattern",
                left: value,
                right: this.parseAssignmentExpression(),
              };
            }
          } else {
            throw this.error("Invalid object pattern key");
          }
        } else if (keyToken.type === "string" || keyToken.type === "number") {
          key = String(keyToken.type === "number" ? Number(keyToken.value) : keyToken.value);
          this.advance();
          this.expectValue(":");
          value = this.parseBindingElement();
        } else if (this.matchValue("[")) {
          key = this.parseExpression();
          computed = true;
          this.expectValue("]");
          this.expectValue(":");
          value = this.parseBindingElement();
        } else {
          throw this.error("Invalid object pattern key");
        }

        properties.push({
          type: "Property",
          key,
          computed,
          value,
        });
      } while (this.matchValue(",") && !this.isValue("}"));

      this.expectValue("}");
    }

    return {
      type: "ObjectPattern",
      properties,
    };
  }

  parseIdentifier() {
    const token = this.expectType("identifier");
    return {
      type: "Identifier",
      name: token.value,
    };
  }

  parseIdentifierName() {
    const token = this.current();
    if (token.type !== "identifier" && token.type !== "keyword") {
      throw this.error("Expected identifier");
    }
    this.advance();
    return {
      type: "Identifier",
      name: token.value,
    };
  }

  consumeSemicolon() {
    if (this.matchValue(";")) {
      return;
    }

    if (this.is("eof") || this.isValue("}")) {
      return;
    }
  }

  isAssignmentOperator(value) {
    return (
      value === "=" ||
      value === "+=" ||
      value === "-=" ||
      value === "*=" ||
      value === "/=" ||
      value === "%=" ||
      value === "**=" ||
      value === "??=" ||
      value === "&=" ||
      value === "|=" ||
      value === "^=" ||
      value === "<<=" ||
      value === ">>=" ||
      value === ">>>="
    );
  }

  current() {
    return this.tokens[this.index];
  }

  peek(offset = 1) {
    return this.tokens[this.index + offset] ?? this.tokens[this.tokens.length - 1];
  }

  advance() {
    const token = this.current();
    if (token.type !== "eof") {
      this.index += 1;
    }
    return token;
  }

  is(type) {
    return this.current().type === type;
  }

  isValue(value) {
    const token = this.current();
    return (
      (token.type === "operator" || token.type === "punctuation" || token.type === "eof") &&
      token.value === value
    );
  }

  isKeyword(value) {
    return this.current().type === "keyword" && this.current().value === value;
  }

  matchValue(value) {
    if (this.isValue(value)) {
      this.advance();
      return true;
    }
    return false;
  }

  matchKeyword(value) {
    if (this.isKeyword(value)) {
      this.advance();
      return true;
    }
    return false;
  }

  expectValue(value) {
    if (!this.matchValue(value)) {
      throw this.error(`Expected '${value}'`);
    }
    return this.tokens[this.index - 1];
  }

  expectKeyword(value) {
    if (!this.matchKeyword(value)) {
      throw this.error(`Expected keyword '${value}'`);
    }
    return this.tokens[this.index - 1];
  }

  expectType(type) {
    const token = this.current();
    if (token.type !== type) {
      throw this.error(`Expected ${type}`);
    }
    this.advance();
    return token;
  }

  error(message) {
    return new JSLiteSyntaxError(message, this.current());
  }
}

function parseEmbeddedExpressionSource(source) {
  const parser = new Parser(source);
  const expression = parser.parseExpression();
  if (!parser.is("eof")) {
    throw parser.error("Unexpected token after template interpolation");
  }
  return expression;
}
