/* eslint-disable @typescript-eslint/no-require-imports -- Shared CommonJS tooling entry point. */
const ts = require('typescript');
const path = require('node:path');

/** Read static declarations without executing application modules. */
function extractCatalogue(files, root) {
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    baseUrl: root,
    paths: { '@app/*': ['src/*'], '@server/*': ['server/*'] },
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const active = new Set();
  function fail(node, reason) {
    const source = node.getSourceFile();
    const location = source.getLineAndCharacterOfPosition(node.getStart());
    throw new Error(`${source.fileName}:${location.line + 1}: ${reason}`);
  }
  function evaluate(node) {
    if (!node) throw new Error('Missing message expression');
    if (active.has(node)) fail(node, 'Circular message reference');
    active.add(node);
    try {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
        return node.text;
      if (
        ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isSatisfiesExpression(node) ||
        ts.isTypeAssertionExpression(node)
      )
        return evaluate(node.expression);
      if (ts.isIdentifier(node)) {
        let symbol = checker.getSymbolAtLocation(node);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias)
          symbol = checker.getAliasedSymbol(symbol);
        const declaration = symbol?.valueDeclaration;
        if (
          declaration &&
          ts.isVariableDeclaration(declaration) &&
          declaration.parent.flags & ts.NodeFlags.Const
        )
          return evaluate(declaration.initializer);
      }
      if (ts.isObjectLiteralExpression(node)) {
        const result = Object.create(null);
        for (const property of node.properties) {
          if (ts.isSpreadAssignment(property)) {
            const spread = evaluate(property.expression);
            if (typeof spread !== 'object')
              fail(property, 'Message spread must be an object');
            Object.assign(result, spread);
          } else if (ts.isPropertyAssignment(property)) {
            const name = property.name;
            if (!ts.isIdentifier(name) && !ts.isStringLiteral(name))
              fail(name, 'Unsupported message key');
            const value = evaluate(property.initializer);
            if (typeof value !== 'string')
              fail(property, 'Message must be a static string');
            result[name.text] = value;
          } else fail(property, 'Unsupported message property');
        }
        return result;
      }
      fail(node, 'Unsupported non-static message expression');
    } finally {
      active.delete(node);
    }
  }
  const result = Object.create(null);
  const conflicts = [];
  for (const file of [...files].sort()) {
    const source = program.getSourceFile(path.resolve(file));
    if (!source) throw new Error(`Cannot read ${file}`);
    if (source.parseDiagnostics.length)
      fail(source, 'Invalid TypeScript syntax');
    function visit(node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'defineMessages'
      ) {
        const namespace = evaluate(node.arguments[0]);
        const messages = evaluate(node.arguments[1]);
        if (typeof namespace !== 'string' || typeof messages !== 'object')
          fail(node, 'Expected a namespace and message object');
        for (const [key, value] of Object.entries(messages)) {
          const id = `${namespace}.${key}`;
          if (Object.hasOwn(result, id) && result[id] !== value)
            conflicts.push(`Conflicting message ${id} in ${file}`);
          result[id] = value;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  if (conflicts.length) throw new Error(conflicts.join('\n'));
  return JSON.stringify(result, Object.keys(result).sort(), '  ') + '\n';
}

module.exports = { extractCatalogue };
