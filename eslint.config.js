import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'output/**', 'src/**/*.generated.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js', '.prettierrc.json'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          // Omitting a key by destructuring the rest is the idiom used to
          // remove a setting from the config file immutably.
          ignoreRestSiblings: true,
        },
      ],
      // The output contract (§4.2) lives in src/cli/output.ts and nowhere else.
      'no-console': 'error',
    },
  },
  {
    files: ['src/cli/output.ts', 'scripts/**/*.mjs', 'test/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['scripts/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
)
