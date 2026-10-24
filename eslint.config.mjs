import { builtinModules } from 'node:module';
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Dependency direction (IMPLEMENTATION_DRAFT §4):
//   renderer -> contracts (+ preload bridge types); core -> contracts; adapters -> core + contracts;
//   contracts -> nothing. app/main and app/preload may use everything but the renderer.
const nodeBuiltins = [...new Set(builtinModules.filter((m) => !m.startsWith('_') && !m.startsWith('node:')))];
const uiPackages = ['electron', 'react', 'react-dom'];
const anyDepth = (dir) => [`**/${dir}`, `**/${dir}/**`];

const restrict = (message, { paths = [], patterns = [] }) => ({
  'no-restricted-imports': [
    'error',
    {
      paths: paths.map((name) => ({ name, message })),
      patterns: [{ group: patterns, message }],
    },
  ],
});

export default tseslint.config(
  { ignores: ['node_modules/**', 'out/**', 'dist/**', 'build/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.web.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['app/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...restrict(
        'app/renderer may depend only on contracts (and the preload bridge types), never on core, adapters, Electron or Node.',
        {
          paths: [...nodeBuiltins, 'electron'],
          patterns: [
            'node:*',
            ...anyDepth('core'),
            ...anyDepth('adapters'),
            ...anyDepth('main'),
            '**/preload/*',
            '!**/preload/bridge-types',
          ],
        },
      ),
    },
  },
  {
    files: ['core/**/*.ts'],
    rules: restrict('core must not depend on Electron, React, Node, adapters or app code.', {
      paths: [...nodeBuiltins, ...uiPackages],
      patterns: ['node:*', ...anyDepth('adapters'), ...anyDepth('app')],
    }),
  },
  {
    files: ['contracts/**/*.ts'],
    rules: restrict('contracts must not depend on any other layer.', {
      paths: uiPackages,
      patterns: [...anyDepth('core'), ...anyDepth('adapters'), ...anyDepth('app')],
    }),
  },
  {
    files: ['adapters/**/*.ts'],
    rules: restrict('adapters must not depend on app code or UI libraries.', {
      paths: uiPackages,
      patterns: anyDepth('app'),
    }),
  },
);
