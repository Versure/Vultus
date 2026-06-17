// PERMANENT NEGATIVE-TEST FIXTURE — do not "fix" this import.
//
// This file is tagged `scope:mobile` (see sheriff.config.ts) and deliberately
// imports a `scope:functions` module, violating boundary rule 1
// (scope:mobile cannot import scope:functions). The Sheriff dependency-rule must
// flag it; the test in tools/sheriff-test asserts that it does. If Sheriff ever
// stops reporting this, that test fails — which is the whole point.
//
// It is excluded from every production lint/build target (eslint.config.mjs
// `ignores` + tsconfig excludes), so default `nx lint` / `nx build` stay green.
import { FUNCTIONS_ONLY_SECRET } from '../functions-side/secret';

export const leaked = FUNCTIONS_ONLY_SECRET;
