// Dependency-direction rules (IMPLEMENTATION_DRAFT §4), shared by eslint.config.mjs and the
// regression test in tests/lint-boundaries.test.ts.
//   renderer -> contracts (+ preload bridge types); core -> contracts; adapters -> core + contracts;
//   contracts -> nothing. app/main and app/preload may use everything but the renderer.
import { builtinModules } from 'node:module';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const root = import.meta.dirname;

// Every source extension TypeScript or Node may load, so no extension escapes the rules.
const sourceExtensions = '{ts,tsx,mts,cts,js,jsx,mjs,cjs}';
const sourceExtensionPattern = /\.(d\.)?[cm]?[jt]sx?$/;

const nodeBuiltins = [...new Set(builtinModules.filter((m) => !m.startsWith('_')).map((m) => m.replace(/^node:/, '')))];

// Bare specifiers (packages, Node builtins) are matched against these regex sources.
const pkg = (...names) => `^(${names.join('|')})(/.*)?$`;
const nodeModules = `^(node:.*|(${nodeBuiltins.join('|')})(/.*)?)$`;
const uiPackages = pkg('electron', 'react', 'react-dom');

const nodeGlobals = ['process', 'Buffer', 'require', 'module', '__dirname', '__filename', 'global'];

// Relative specifiers are resolved against the importing file and must land inside `allowedPaths`
// (repo-relative, extension-less; a path allows itself and everything below it).
const isBare = (specifier) => !specifier.startsWith('.') && !isAbsolute(specifier);

// `pkg/../core/x` looks like a package but resolvers normalise it into a path elsewhere.
const hasDotSegment = (specifier) => specifier.split(/[\\/]/).some((segment) => segment === '.' || segment === '..');

const isAllowedPath = (specifier, filename, allowedPaths) => {
  const target = relative(root, resolve(dirname(filename), specifier)).split('\\').join('/').replace(sourceExtensionPattern, '');
  return allowedPaths.some((allowed) => target === allowed || target.startsWith(`${allowed}/`));
};

/** Reports every way of loading a module that the layer may not depend on. */
const noRestrictedLoads = {
  meta: {
    type: 'problem',
    schema: [
      {
        type: 'object',
        properties: {
          forbiddenPackages: { type: 'array', items: { type: 'string' } },
          allowedPaths: { type: 'array', items: { type: 'string' } },
          message: { type: 'string' },
        },
        required: ['forbiddenPackages', 'allowedPaths', 'message'],
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const { forbiddenPackages, allowedPaths, message } = context.options[0];
    const packagePatterns = forbiddenPackages.map((source) => new RegExp(source));

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
      const forbidden = isBare(specifier)
        ? hasDotSegment(specifier) || packagePatterns.some((re) => re.test(specifier.replaceAll('\\', '/')))
        : !isAllowedPath(specifier, context.filename, allowedPaths);
      if (forbidden) context.report({ node, message: `'${specifier}' is not allowed here. ${message}` });
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

const layer = (dir, message, { forbiddenPackages, allowedPaths, globals = [] }) => ({
  files: [`${dir}/**/*.${sourceExtensions}`],
  plugins: { layer: layerPlugin },
  rules: {
    'layer/no-restricted-loads': ['error', { forbiddenPackages, allowedPaths, message }],
    ...(globals.length > 0 && {
      'no-restricted-globals': ['error', ...globals.map((name) => ({ name, message }))],
    }),
  },
});

export const layerConfigs = [
  layer(
    'app/renderer',
    'app/renderer may depend only on contracts (and the preload bridge types), never on core, adapters, Electron or Node.',
    {
      forbiddenPackages: [nodeModules, pkg('electron')],
      allowedPaths: ['app/renderer', 'contracts', 'app/preload/bridge-types'],
      globals: nodeGlobals,
    },
  ),
  layer('core', 'core must not depend on Electron, React, Node, adapters or app code.', {
    forbiddenPackages: [nodeModules, uiPackages],
    allowedPaths: ['core', 'contracts'],
    globals: nodeGlobals,
  }),
  layer('contracts', 'contracts must not depend on any other layer, Node or UI libraries.', {
    forbiddenPackages: [nodeModules, uiPackages],
    allowedPaths: ['contracts'],
    globals: nodeGlobals,
  }),
  layer('adapters', 'adapters may depend only on core and contracts, not on app code or UI libraries.', {
    forbiddenPackages: [uiPackages],
    allowedPaths: ['adapters', 'core', 'contracts'],
  }),
];
