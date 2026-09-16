import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  // Global ignores (in addition to the default node_modules and .git).
  globalIgnores([
    'cdk.out',
    'coverage',
    '.pnpm-store',
    '**/*.d.ts',
    // Compiled JS emitted next to TS is ignored; hand-written Lambda/CloudFront
    // sources under lib/**/lambda are linted via the JS override below.
  ]),

  // Base configs.
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  // TypeScript project settings + shared rule tweaks.
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Allow intentionally unused args/vars when prefixed with underscore.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Plain JS files (config files, Lambda/CloudFront function sources) have no
  // tsconfig coverage, so disable type-checked rules for them.
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // Lambda handlers and CloudFront Functions declare an entry point that the AWS
  // runtime invokes by name, so it is not referenced within the file itself.
  {
    files: ['lib/**/lambda/**/*.js'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': 'off',
    },
  },

  // Prettier must be last so it can turn off conflicting stylistic rules.
  eslintConfigPrettier,
]);
