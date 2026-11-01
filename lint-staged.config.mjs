/**
 * Pre-commit formatting/linting for staged files only. The full typecheck,
 * unit suite and build live in CI, so commits stay fast.
 */
const config = {
  "*.{js,jsx,mjs,cjs,ts,tsx}": ["prettier --write", "eslint --fix"],
  "*.{json,css}": ["prettier --write"],
};

export default config;
