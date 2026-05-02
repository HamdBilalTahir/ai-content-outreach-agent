import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import typescriptEslint from "@typescript-eslint/eslint-plugin";
import typescriptParser from "@typescript-eslint/parser";

const eslintConfig = [
  js.configs.recommended,
  {
    plugins: {
      "@next/next": nextPlugin,
      "@typescript-eslint": typescriptEslint,
    },
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "error",
    },
  },
  {
    ignores: [".next/", "node_modules/"],
  },
];

export default eslintConfig;
