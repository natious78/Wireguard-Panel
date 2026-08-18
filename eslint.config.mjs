import { FlatCompat } from "@eslint/eslintrc";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: directory });

const config = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  { ignores: [".next/**", "coverage/**", "next-env.d.ts", "public/sw.js"] },
];

export default config;
