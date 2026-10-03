import ts from 'typescript';

const minorWords = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'by',
  'for',
  'from',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
]);

const componentHeadingProps = new Map([
  ['CompactSelect', ['label']],
  ['DetailDisclosureButton', ['label']],
  ['Modal', ['title']],
  ['PageStatus', ['label']],
  ['PageErrorMessage', ['title']],
  ['ExpandableCreditList', ['title', 'emptyLabel']],
  ['PageTitle', ['title']],
  ['RequestActionConfirmation', ['heading']],
  ['RequestListboxControl', ['label']],
]);

const unwrap = (expression) => {
  let current = expression;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current))
  ) {
    current = current.expression;
  }
  return current;
};

const propertyName = (node) => {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  return undefined;
};

const staticText = (expression) => {
  const node = unwrap(expression);
  if (!node) return undefined;
  if (ts.isJsxText(node)) return node.text.replace(/\s+/g, ' ').trim();
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node) && node.templateSpans.length === 0) {
    return node.head.text;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticText(node.left);
    const right = staticText(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
};

const findReturns = (node) => {
  if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) return [node.body];
  const expressions = [];
  const visit = (child) => {
    if (child !== node && ts.isFunctionLike(child)) return;
    if (ts.isReturnStatement(child) && child.expression) {
      expressions.push(child.expression);
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node.body ?? node);
  return expressions;
};

const jsxTagName = (node) => {
  const tag = node.tagName;
  if (ts.isIdentifier(tag)) return tag.text;
  return tag.getText();
};

const jsxAttribute = (attributes, name) =>
  attributes.properties.find(
    (attribute) =>
      ts.isJsxAttribute(attribute) && attribute.name.getText() === name
  );

const jsxAttributeExpression = (attribute) => {
  if (!attribute?.initializer) return undefined;
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer;
  if (ts.isJsxExpression(attribute.initializer)) {
    return attribute.initializer.expression;
  }
  return undefined;
};

const collectStaticStrings = (expression, values = []) => {
  const node = unwrap(expression);
  if (!node) return values;
  if (ts.isStringLiteralLike(node)) {
    values.push(node.text);
    return values;
  }
  if (ts.isTemplateExpression(node)) {
    values.push(node.head.text);
    for (const span of node.templateSpans) {
      collectStaticStrings(span.expression, values);
      values.push(span.literal.text);
    }
    return values;
  }
  if (ts.isConditionalExpression(node)) {
    collectStaticStrings(node.whenTrue, values);
    collectStaticStrings(node.whenFalse, values);
    return values;
  }
  if (ts.isBinaryExpression(node)) {
    collectStaticStrings(node.left, values);
    collectStaticStrings(node.right, values);
    return values;
  }
  if (ts.isArrayLiteralExpression(node)) {
    node.elements.forEach((element) => collectStaticStrings(element, values));
  }
  return values;
};

const classTokens = (opening) => {
  const attribute = jsxAttribute(opening.attributes, 'className');
  const expression = jsxAttributeExpression(attribute);
  return collectStaticStrings(expression)
    .flatMap((value) => value.split(/\s+/))
    .filter(Boolean);
};

const isSemanticHeadingClass = (token) =>
  token === 'app-timeline-label' ||
  token === 'card-table-heading' ||
  token === 'detail-disclosure-button' ||
  token === 'discover-filter-control-label' ||
  /(?:^|-)(?:heading|title)$/.test(token);

const hasCardTableAncestor = (node) => {
  let current = node.parent;
  while (current) {
    if (ts.isJsxElement(current)) {
      if (classTokens(current.openingElement).includes('card-table'))
        return true;
    }
    current = current.parent;
  }
  return false;
};

const objectPropertiesNamed = (expression, name, model, seen = new Set()) => {
  const node = unwrap(expression);
  if (!node) return [];
  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return [];
    seen.add(node.text);
    return objectPropertiesNamed(
      model.variables.get(node.text),
      name,
      model,
      seen
    );
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap((element) =>
      ts.isSpreadElement(element)
        ? objectPropertiesNamed(element.expression, name, model, seen)
        : objectPropertiesNamed(element, name, model, seen)
    );
  }
  if (ts.isConditionalExpression(node)) {
    return [
      ...objectPropertiesNamed(node.whenTrue, name, model, seen),
      ...objectPropertiesNamed(node.whenFalse, name, model, seen),
    ];
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.flatMap((property) => {
      if (ts.isSpreadAssignment(property)) {
        return objectPropertiesNamed(property.expression, name, model, seen);
      }
      if (
        (ts.isPropertyAssignment(property) ||
          ts.isShorthandPropertyAssignment(property)) &&
        propertyName(property.name) === name
      ) {
        return [
          ts.isShorthandPropertyAssignment(property)
            ? property.name
            : property.initializer,
        ];
      }
      return [];
    });
  }
  return [];
};

const buildModel = ({ path, source }) => {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const variables = new Map();
  const functions = new Map();

  const index = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      variables.set(node.name.text, node.initializer);
      if (
        ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer)
      ) {
        functions.set(node.name.text, node.initializer);
      }
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      functions.set(node.name.text, node);
    }
    ts.forEachChild(node, index);
  };
  index(sourceFile);

  const resolveObject = (expression, seen = new Set()) => {
    const node = unwrap(expression);
    if (!node) return undefined;
    if (ts.isObjectLiteralExpression(node)) return node;
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      seen.add(node.text);
      return resolveObject(variables.get(node.text), seen);
    }
    return undefined;
  };

  const objectDefaults = (expression, seen = new Set()) => {
    const object = resolveObject(expression, seen);
    if (!object) return new Map();
    const values = new Map();
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) {
        for (const [key, value] of objectDefaults(property.expression, seen)) {
          values.set(key, value);
        }
      } else if (ts.isPropertyAssignment(property)) {
        const key = propertyName(property.name);
        const value = staticText(property.initializer);
        if (key && value !== undefined) values.set(key, value);
      }
    }
    return values;
  };

  const messageGroups = new Map();
  for (const [name, initializer] of variables) {
    const call = unwrap(initializer);
    if (
      !call ||
      !ts.isCallExpression(call) ||
      !ts.isIdentifier(call.expression) ||
      call.expression.text !== 'defineMessages'
    ) {
      continue;
    }
    const prefix = staticText(call.arguments[0]);
    if (!prefix || !call.arguments[1]) continue;
    messageGroups.set(name, {
      prefix,
      defaults: objectDefaults(call.arguments[1]),
    });
  }

  return {
    path,
    source,
    sourceFile,
    variables,
    functions,
    messageGroups,
    objectDefaults,
  };
};

const possibleKeys = (expression, model, seen = new Set()) => {
  const node = unwrap(expression);
  if (!node) return [];
  const text = staticText(node);
  if (text !== undefined) return [text];
  if (ts.isConditionalExpression(node)) {
    return [
      ...possibleKeys(node.whenTrue, model, seen),
      ...possibleKeys(node.whenFalse, model, seen),
    ];
  }
  if (ts.isBinaryExpression(node)) {
    return [
      ...possibleKeys(node.left, model, seen),
      ...possibleKeys(node.right, model, seen),
    ];
  }
  if (ts.isPropertyAccessExpression(node)) {
    const object = unwrap(node.expression);
    if (ts.isIdentifier(object)) {
      const defaults = model.objectDefaults(model.variables.get(object.text));
      const value = defaults.get(node.name.text);
      return value === undefined ? [] : [value];
    }
  }
  if (ts.isElementAccessExpression(node)) {
    const object = unwrap(node.expression);
    if (ts.isIdentifier(object)) {
      const defaults = model.objectDefaults(model.variables.get(object.text));
      const indexKeys = possibleKeys(node.argumentExpression, model, seen);
      if (indexKeys.length > 0) {
        return indexKeys.map((key) => defaults.get(key)).filter(Boolean);
      }
      return [...defaults.values()];
    }
  }
  if (ts.isIdentifier(node) && !seen.has(node.text)) {
    seen.add(node.text);
    const initializer = model.variables.get(node.text);
    if (initializer) return possibleKeys(initializer, model, seen);
  }
  return [];
};

const messageReferences = (expression, model) => {
  const node = unwrap(expression);
  if (!node) return [];
  if (ts.isPropertyAccessExpression(node)) {
    const groupName = ts.isIdentifier(node.expression)
      ? node.expression.text
      : undefined;
    const group = groupName ? model.messageGroups.get(groupName) : undefined;
    if (!group) return [];
    const key = node.name.text;
    return group.defaults.has(key) ? [{ groupName, key, ...group }] : [];
  }
  if (ts.isElementAccessExpression(node)) {
    const groupName = ts.isIdentifier(node.expression)
      ? node.expression.text
      : undefined;
    const group = groupName ? model.messageGroups.get(groupName) : undefined;
    if (!group) return [];
    return possibleKeys(node.argumentExpression, model).flatMap((key) =>
      group.defaults.has(key) ? [{ groupName, key, ...group }] : []
    );
  }
  if (ts.isConditionalExpression(node)) {
    return [
      ...messageReferences(node.whenTrue, model),
      ...messageReferences(node.whenFalse, model),
    ];
  }
  if (ts.isBinaryExpression(node)) {
    return [
      ...messageReferences(node.left, model),
      ...messageReferences(node.right, model),
    ];
  }
  return [];
};

const semanticText = (
  expression,
  model,
  role,
  seen = new Set(),
  origin = expression
) => {
  const node = unwrap(expression);
  if (!node) return { candidates: [], unresolved: [] };
  const result = { candidates: [], unresolved: [] };
  const merge = (part) => {
    result.candidates.push(...part.candidates);
    result.unresolved.push(...part.unresolved);
  };
  const literal = staticText(node);
  if (literal !== undefined) {
    if (literal.trim()) {
      result.candidates.push({
        kind: 'literal',
        value: literal.trim(),
        role,
        path: model.path,
        line:
          model.sourceFile.getLineAndCharacterOfPosition(origin.pos).line + 1,
      });
    }
    return result;
  }
  if (ts.isJsxFragment(node) || ts.isJsxElement(node)) {
    for (const childExpression of semanticExpressions(node, model)) {
      merge(semanticText(childExpression, model, role, seen, origin));
    }
    return result;
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === 'formatMessage' &&
      node.arguments[0]
    ) {
      for (const reference of messageReferences(node.arguments[0], model)) {
        result.candidates.push({
          kind: 'message',
          role,
          path: model.path,
          line:
            model.sourceFile.getLineAndCharacterOfPosition(origin.pos).line + 1,
          ...reference,
          value: reference.defaults.get(reference.key),
        });
      }
      return result;
    }
    if (ts.isIdentifier(callee) && model.functions.has(callee.text)) {
      const marker = `function:${callee.text}`;
      if (seen.has(marker)) return result;
      const nextSeen = new Set(seen).add(marker);
      for (const returned of findReturns(model.functions.get(callee.text))) {
        merge(semanticText(returned, model, role, nextSeen, origin));
      }
      return result;
    }
  }
  if (ts.isConditionalExpression(node)) {
    merge(semanticText(node.whenTrue, model, role, seen, origin));
    merge(semanticText(node.whenFalse, model, role, seen, origin));
    return result;
  }
  if (ts.isBinaryExpression(node)) {
    merge(semanticText(node.left, model, role, seen, origin));
    merge(semanticText(node.right, model, role, seen, origin));
    return result;
  }
  if (ts.isIdentifier(node) && model.variables.has(node.text)) {
    const marker = `variable:${node.text}`;
    if (!seen.has(marker)) {
      return semanticText(
        model.variables.get(node.text),
        model,
        role,
        new Set(seen).add(marker),
        origin
      );
    }
  }
  result.unresolved.push({
    role,
    path: model.path,
    line: model.sourceFile.getLineAndCharacterOfPosition(origin.pos).line + 1,
    expression: node.getText(model.sourceFile),
  });
  return result;
};

const semanticExpressions = (element, model) => {
  const expressions = [];
  for (const child of element.children) {
    if (ts.isJsxText(child)) {
      const text = child.text.replace(/\s+/g, ' ').trim();
      if (text && text !== ':') expressions.push(child);
    } else if (ts.isJsxExpression(child) && child.expression) {
      expressions.push(child.expression);
    } else if (ts.isJsxElement(child)) {
      expressions.push(...semanticExpressions(child, model));
    }
  }
  return expressions;
};

const discoverFromModel = (model) => {
  const candidates = [];
  const unresolved = [];
  const consume = (expression, role) => {
    const result = semanticText(expression, model, role);
    candidates.push(...result.candidates);
    unresolved.push(...result.unresolved);
  };

  const visit = (node) => {
    if (ts.isJsxElement(node)) {
      const opening = node.openingElement;
      const tag = jsxTagName(opening);
      const tokens = classTokens(opening);
      const semanticByClass = tokens.some(isSemanticHeadingClass);
      const semanticCardCell =
        (tag === 'dt' || tag === 'th') && hasCardTableAncestor(node);
      if (semanticByClass || semanticCardCell) {
        const role = semanticCardCell
          ? 'card-table-heading'
          : tokens.find(isSemanticHeadingClass);
        semanticExpressions(node, model)
          .filter(
            (expression) =>
              role !== 'detail-disclosure-button' ||
              !ts.isIdentifier(unwrap(expression)) ||
              unwrap(expression).text !== 'icon'
          )
          .forEach((expression) => consume(expression, role));
      }
    }

    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = jsxTagName(node);
      for (const prop of componentHeadingProps.get(tag) ?? []) {
        const expression = jsxAttributeExpression(
          jsxAttribute(node.attributes, prop)
        );
        if (expression) consume(expression, `${tag}.${prop}`);
      }
      if (tag === 'PinnedFilterSectionGroup') {
        const sections = jsxAttributeExpression(
          jsxAttribute(node.attributes, 'sections')
        );
        for (const expression of objectPropertiesNamed(
          sections,
          'label',
          model
        )) {
          consume(expression, 'DetailDisclosureButton.label');
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(model.sourceFile);

  return { candidates, unresolved };
};

export const isTitleCase = (value) => {
  const withoutArguments = value.replace(/\{[^{}]*\}/g, ' ');
  const words =
    withoutArguments.match(/[A-Za-z][A-Za-z0-9]*(?:['’-][A-Za-z0-9]+)*/g) ?? [];
  return words.every(
    (word, index) =>
      /^[A-Z]/.test(word) || (index > 0 && minorWords.has(word.toLowerCase()))
  );
};

export const verifySemanticHeadings = ({ files, english = {} }) => {
  const discovered = files.map(buildModel).map(discoverFromModel);
  const candidates = discovered.flatMap((entry) => entry.candidates);
  const unresolved = discovered.flatMap((entry) => entry.unresolved);
  const uniqueCandidates = [
    ...new Map(
      candidates.map((candidate) => [
        `${candidate.path}:${candidate.line}:${candidate.role}:${candidate.kind}:${candidate.prefix ?? ''}:${candidate.key ?? ''}:${candidate.value}`,
        candidate,
      ])
    ).values(),
  ];
  const errors = [];

  for (const candidate of uniqueCandidates) {
    if (!isTitleCase(candidate.value)) {
      errors.push(
        `${candidate.path}:${candidate.line} ${candidate.role} default is not title case: ${candidate.value}`
      );
    }
    if (candidate.kind !== 'message') continue;
    const id = `${candidate.prefix}.${candidate.key}`;
    const active = english[id] ?? candidate.value;
    if (active !== candidate.value) {
      errors.push(
        `${candidate.path}:${candidate.line} ${id} active English text differs from its semantic heading default: ${active} != ${candidate.value}`
      );
    }
    if (!isTitleCase(active)) {
      errors.push(
        `${candidate.path}:${candidate.line} ${id} active English text is not title case: ${active}`
      );
    }
  }

  return { candidates: uniqueCandidates, unresolved, errors };
};
