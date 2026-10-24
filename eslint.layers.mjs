// Dependency-direction rules (IMPLEMENTATION_DRAFT §4), shared by eslint.config.mjs and the
// regression test in tests/lint-boundaries.test.ts.
//   renderer -> contracts (+ preload bridge types); core -> contracts; adapters -> core + contracts;
//   contracts -> nothing. app/main and app/preload may use everything but the renderer.
import { builtinModules } from 'node:module';

const nodeBuiltins = [...new Set(builtinModules.filter((m) => !m.startsWith('_')).map((m) => m.replace(/^node:/, '')))];

// Regex sources matched against the module specifier of every import/export-from/import()/require().
const pkg = (...names) => `^(${names.join('|')})(/.*)?$`;
const dir = (name) => `(^|/)${name}(/|$)`;
const nodeModules = `^(node:.*|(${nodeBuiltins.join('|')})(/.*)?)$`;
const uiPackages = pkg('electron', 'react', 'react-dom');
// app/main, referenced by path or by a relative climb out of app/renderer.
const appMain = String.raw`(^|/)app/main(/|$)|^(\.\./)+main(/|$)`;
// Everything under a preload directory except the import-free bridge types.
const preloadExceptBridgeTypes = '(^|/)preload(/(?!bridge-types$).*)?$';

const nodeGlobals = ['process', 'Buffer', 'require', 'module', '__dirname', '__filename', 'global'];

/** Reports every way of loading a module whose specifier matches `forbidden`. */
const noRestrictedLoads = {
  meta: {
    type: 'problem',
    schema: [
      {
        type: 'object',
        properties: { forbidden: { type: 'array', items: { type: 'string' } }, message: { type: 'string' } },
        required: ['forbidden', 'message'],
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const { forbidden, message } = context.options[0];
    const patterns = forbidden.map((source) => new RegExp(source));

    const specifierOf = (node) => {
      if (!node) return undefined;
      if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
      if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
      return undefined;
    };
    const check = (node, specifierNode, { dynamic }) => {
      const specifier = specifierOf(specifierNode);
      if (specifier === undefined) {
        // `import(expr)` / `require(expr)` cannot be analysed, so it is not allowed in a restricted layer.
        if (dynamic) context.report({ node, message: `Non-literal module specifier. ${message}` });
        return;
      }
      if (patterns.some((re) => re.test(specifier))) {
        context.report({ node, message: `'${specifier}' is not allowed here. ${message}` });
      }
    };

    return {
      ImportDeclaration: (node) => check(node, node.source, { dynamic: false }),
      ExportNamedDeclaration: (node) => node.source && check(node, node.source, { dynamic: false }),
      ExportAllDeclaration: (node) => check(node, node.source, { dynamic: false }),
      ImportExpression: (node) => check(node, node.source, { dynamic: true }),
      TSImportType: (node) => {
        const source = node.source ?? node.argument;
        check(node, source?.literal ?? source, { dynamic: false });
      },
      TSExternalModuleReference: (node) => check(node, node.expression, { dynamic: false }),
      CallExpression: (node) => {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
          check(node, node.arguments[0], { dynamic: true });
        }
      },
    };
  },
};

export const layerPlugin = { rules: { 'no-restricted-loads': noRestrictedLoads } };

const layer = (files, message, forbidden, { globals = [] } = {}) => ({
  files,
  plugins: { layer: layerPlugin },
  rules: {
    'layer/no-restricted-loads': ['error', { forbidden, message }],
    ...(globals.length > 0 && {
      'no-restricted-globals': ['error', ...globals.map((name) => ({ name, message }))],
    }),
  },
});

export const layerConfigs = [
  layer(
    ['app/renderer/**/*.{ts,tsx}'],
    'app/renderer may depend only on contracts (and the preload bridge types), never on core, adapters, Electron or Node.',
    [nodeModules, pkg('electron'), dir('core'), dir('adapters'), appMain, preloadExceptBridgeTypes],
    { globals: nodeGlobals },
  ),
  layer(
    ['core/**/*.ts'],
    'core must not depend on Electron, React, Node, adapters or app code.',
    [nodeModules, uiPackages, dir('adapters'), dir('app')],
    { globals: nodeGlobals },
  ),
  layer(
    ['contracts/**/*.ts'],
    'contracts must not depend on any other layer, Node or UI libraries.',
    [nodeModules, uiPackages, dir('core'), dir('adapters'), dir('app')],
    { globals: nodeGlobals },
  ),
  layer(['adapters/**/*.ts'], 'adapters must not depend on app code or UI libraries.', [uiPackages, dir('app')]),
];
