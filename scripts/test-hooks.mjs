// Resolve hook for the check scripts (see test-register.mjs).
// Plain node cannot resolve the `@/` alias — and the backup test needs
// `@prisma/client` to point at a throwaway sqlite client rather than whatever
// node_modules holds. Both mappings come from the environment:
//   TEST_REPO_ROOT     absolute path of the checkout (for @/)
//   TEST_PRISMA_CLIENT absolute path of a generated client dir (for @prisma/client)
//
// It also postfixes extensionless relative imports (./prisma -> ./prisma.ts).
// Ship code spells imports the bundler way; node ESM does no extension
// searching, so the test plumbing does it instead of the source.
import { existsSync } from "node:fs";

const EXTENSIONS = [".ts", ".tsx", ".js", ".mjs"];

// Bare path in, resolved file URL out (or null). Ship code spells imports the
// bundler way; node ESM does no extension searching, so the hook does it.
function resolveFile(href) {
  try {
    if (existsSync(new URL(href))) return { url: href, shortCircuit: true };
  } catch {
    return null;
  }
  if (href.match(/\.[a-z0-9]+$/i)) return null;
  for (const ext of EXTENSIONS) {
    const candidate = href + ext;
    try {
      if (existsSync(new URL(candidate))) return { url: candidate, shortCircuit: true };
    } catch {
      break;
    }
  }
  return null;
}

// Captured once, at load: --import runs this before the entry point, while cwd
// is still the checkout. (Tests chdir into a temp app root later, so reading
// cwd per-call would mis-resolve after that.)
const REPO_ROOT = process.env.TEST_REPO_ROOT || process.cwd();

export async function resolve(specifier, context, nextResolve) {
  const testClient = process.env.TEST_PRISMA_CLIENT;
  if (specifier.startsWith("@/")) {
    return resolveFile(new URL("./" + specifier.slice(2), `file://${REPO_ROOT}/`).href);
  }
  if (testClient && (specifier === "@prisma/client" || specifier === ".prisma/client")) {
    // Chained, not short-circuited: default resolution then handles the file URL
    // exactly as a direct import would (CJS detection included). Short-circuiting
    // with an explicit format loaded the same file with dead named bindings.
    return nextResolve(new URL("./index.js", `file://${testClient}/`).href, context);
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const r = resolveFile(new URL(specifier, context.parentURL).href);
    if (r) return r;
  }
  return nextResolve(specifier);
}
