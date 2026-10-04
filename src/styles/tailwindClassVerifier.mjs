import ts from 'typescript';

const variantPrefix = /^(?:(?:[a-z0-9_-]+|\[[^\]]+\]):)+/i;

export const tailwindUtility =
  /^(?:absolute|relative|fixed|sticky|static|block|inline|inline-block|inline-flex|flex|grid|contents|hidden|sr-only|container|aspect-.+|animate-.+|transform(?:-.+)?|object-.+|overflow(?:-[xy])?-.+|min-[wh]-.+|max-[wh]-.+|[wh]-.+|size-.+|shrink(?:-.+)?|grow(?:-.+)?|basis-.+|flex-(?:1|auto|initial|none|row|row-reverse|col|col-reverse|wrap|wrap-reverse|nowrap|shrink-.+)|items-.+|justify-.+|self-.+|place-.+|col-.+|row-.+|grid-.+|order-.+|gap(?:-[xy])?-.+|space-[xy]-.+|m[trblxy]?-.+|p[trblxy]?-.+|inset(?:-[xy])?-.+|top-.+|right-.+|bottom-.+|left-.+|z-.+|translate-[xy]-.+|-translate-[xy]-.+|rotate-.+|-rotate-.+|scale-.+|origin-.+|truncate|line-clamp-.+|break-.+|whitespace-.+|text-(?:xs|sm|base|lg|xl|[2-9]xl|left|center|right|justify|wrap|nowrap|ellipsis|clip|\[.+|(?:gray|red|amber|yellow|green|emerald|blue|indigo|violet|purple|pink|fuchsia|rose|cyan|teal|black|white)(?:-.+)?)|font-.+|leading-.+|bg-.+|rounded(?:-.+)?|shadow(?:-.+)?|backdrop-.+|ring(?:-.+)?|border(?:$|-.+)|opacity-.+|transition(?:-.+)?|duration-.+|ease-.+|cursor-.+|select-.+|pointer-events-.+)$/;

const unwrap = (node) => {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const addText = (text, tokens) => {
  for (const token of text.split(/\s+/).filter(Boolean)) {
    // Normalize modifiers, including negative/logical spacing utilities.
    tokens.add(
      token
        .replace(variantPrefix, '')
        .replace(/^!/, '')
        .replace(/!$/, '')
        .replace(/^-/, '')
        .replace(/^(m|p)[se]-/, '$1l-')
    );
  }
};

const localBindings = (sourceFile) => {
  const bindings = new Map();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      bindings.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings;
};

const collectExpression = (rawNode, state, seen = new Set()) => {
  if (!rawNode) return;
  const node = unwrap(rawNode);

  if (ts.isStringLiteralLike(node)) {
    addText(node.text, state.tokens);
    return;
  }
  if (ts.isTemplateExpression(node)) {
    addText(node.head.text, state.tokens);
    for (const span of node.templateSpans) {
      collectExpression(span.expression, state, seen);
      addText(span.literal.text, state.tokens);
    }
    return;
  }
  if (ts.isConditionalExpression(node)) {
    collectExpression(node.whenTrue, state, seen);
    collectExpression(node.whenFalse, state, seen);
    return;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    collectExpression(node.left, state, seen);
    collectExpression(node.right, state, seen);
    return;
  }
  if (ts.isIdentifier(node)) {
    const initializer = state.bindings.get(node.text);
    if (initializer && !seen.has(node.text)) {
      const nextSeen = new Set(seen).add(node.text);
      collectExpression(initializer, state, nextSeen);
    } else if (!initializer) {
      state.unresolved.add(node.text);
    }
    return;
  }
  if (ts.isCallExpression(node)) {
    const name = node.expression.getText(state.sourceFile);
    if (/^(?:twMerge|clsx|classNames)$/.test(name)) {
      for (const argument of node.arguments) {
        collectExpression(argument, state, seen);
      }
    } else {
      state.unresolved.add(node.getText(state.sourceFile));
    }
    return;
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    if (ts.isBlock(node.body)) {
      const visitReturn = (child) => {
        if (ts.isReturnStatement(child)) {
          collectExpression(child.expression, state, seen);
        } else {
          ts.forEachChild(child, visitReturn);
        }
      };
      visitReturn(node.body);
    } else {
      collectExpression(node.body, state, seen);
    }
    return;
  }
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) {
        collectExpression(property.initializer, state, seen);
      }
    }
    return;
  }
  if (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  ) {
    const object = unwrap(node.expression);
    if (ts.isIdentifier(object)) {
      const initializer = state.bindings.get(object.text);
      if (initializer && ts.isObjectLiteralExpression(unwrap(initializer))) {
        collectExpression(unwrap(initializer), state, seen);
        return;
      }
    }
    state.unresolved.add(node.getText(state.sourceFile));
    return;
  }
  if (
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  ) {
    return;
  }

  state.unresolved.add(node.getText(state.sourceFile));
};

export const auditTailwindClassExpressions = ({ path, source }) => {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const state = {
    sourceFile,
    bindings: localBindings(sourceFile),
    tokens: new Set(),
    unresolved: new Set(),
  };

  const visit = (node) => {
    if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'className' &&
      node.initializer
    ) {
      if (ts.isStringLiteral(node.initializer)) {
        addText(node.initializer.text, state.tokens);
      } else if (ts.isJsxExpression(node.initializer)) {
        collectExpression(node.initializer.expression, state);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return {
    tokens: [...state.tokens],
    utilities: [...state.tokens].filter((token) => tailwindUtility.test(token)),
    unresolved: [...state.unresolved],
  };
};
