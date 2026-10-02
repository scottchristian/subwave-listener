// Preload for the check scripts: installs scripts/test-hooks.mjs before the
// entry point loads. Usage:
//   node --import ./scripts/test-register.mjs scripts/check-backup.mts
import { register } from "node:module";

register("./test-hooks.mjs", import.meta.url);
