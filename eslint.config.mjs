// Workspace-wide flat config: pragmatic ruleset the whole team can live with.
// CI runs `pnpm lint` on every PR (project-plan.md §6).
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/dev-dist/**',
      'apps/api/.pgdata/**',
      'word/**',
      '**/*.mjs',
      'tools-md2docx.py',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      // Nest DTOs/decorators lean on empty classes and non-null assertions
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    // static browser assets served as-is (pre-paint theme script)
    files: ['apps/web/public/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
);
