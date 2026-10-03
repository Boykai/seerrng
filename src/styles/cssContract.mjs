import postcss from 'postcss';

const normalize = (selector) => selector.trim().replace(/\s+/g, ' ');

// Source-contract inspection, not a browser cascade/computed-style substitute.
// Parse real CSS so grouping, comments and declaration order do not masquerade
// as visual regressions. Only exact semantic selectors participate.
export const styleContract = (css) => {
  const rules = [];
  postcss.parse(css).walkRules((rule) => rules.push(rule));
  const rulesFor = (selector) =>
    rules.filter((rule) =>
      rule.selectors.some((entry) => normalize(entry) === normalize(selector))
    );
  return {
    rulesFor,
    declaration(selector, property) {
      const declarations = rulesFor(selector).flatMap((rule) =>
        rule.nodes.filter(
          (node) => node.type === 'decl' && node.prop === property
        )
      );
      const last = declarations.at(-1);
      return last
        ? `${last.value}${last.important ? ' !important' : ''}`
        : undefined;
    },
    applies(selector) {
      return new Set(
        rulesFor(selector).flatMap((rule) =>
          rule.nodes
            .filter((node) => node.type === 'atrule' && node.name === 'apply')
            .flatMap((node) => node.params.split(/\s+/).filter(Boolean))
        )
      );
    },
  };
};
