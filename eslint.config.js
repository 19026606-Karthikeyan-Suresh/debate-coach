import js from '@eslint/js'
import jsdoc from 'eslint-plugin-jsdoc'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import typescriptEslint from 'typescript-eslint'

/**
 * ESLint flat config.
 *
 * The docstring and naming rules here are the enforcement half of the conventions in
 * CLAUDE.md — they are errors, not warnings, because a warning nobody fails on is a
 * convention nobody follows.
 */
export default typescriptEslint.config(
  {
    ignores: ['dist/', 'src-tauri/', 'node_modules/', '.venv/', 'reference/'],
  },

  js.configs.recommended,
  ...typescriptEslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: { ...globals.browser, ...globals.es2023 },
    },
    plugins: { jsdoc, 'react-hooks': reactHooks },
    settings: { jsdoc: { mode: 'typescript' } },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // Docstring on every exported function, type, and interface. `publicOnly` keeps the
      // rule off internal helpers, where a comment at the declaration is the right tool.
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: true,
          require: {
            FunctionDeclaration: true,
            ArrowFunctionExpression: true,
            FunctionExpression: true,
            ClassDeclaration: true,
            MethodDefinition: true,
          },
          contexts: [
            'TSInterfaceDeclaration',
            'TSTypeAliasDeclaration',
            'TSEnumDeclaration',
          ],
        },
      ],

      // A @param that only restates the type is worthless; requiring the description is what
      // forces "what happens if you pass the wrong thing".
      'jsdoc/require-param-description': 'error',
      'jsdoc/require-returns-description': 'error',
      'jsdoc/check-param-names': 'error',
      'jsdoc/check-alignment': 'error',
      // Types live in the signature, not the docstring — TS already has them.
      'jsdoc/no-types': 'error',

      // No single-letter names anywhere: not counters, not lambda params, not generics.
      'id-length': [
        'error',
        { min: 2, properties: 'never', exceptions: ['_'] },
      ],
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'typeParameter', format: ['PascalCase'], custom: { regex: '^.{2,}$', match: true } },
      ],

      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Config files run in Node and are not part of the shipped surface, so the docstring rule
  // applies but the browser globals do not.
  {
    files: ['*.config.{js,ts}', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },

  // Tests run under Node and read the reference .docx off disk, so they need Buffer and the
  // node: builtins. `id-length` stays on — test code is read more often than it is written.
  {
    files: ['src/**/__tests__/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
)
