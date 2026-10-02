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

export async function resolve(specifier, context, nextResolve) {
  const root = process.env.TEST_REPO_ROOT;
  const testClient = process.env.TEST_PRISMA_CLIENT;
  if (root && specifier.startsWith("@/")) {
    return { url: new URL("./" + specifier.slice(2), `file://${root}/`).href, shortCircuit: true };
  }
  if (testClient && (specifier === "@prisma/client" || specifier === ".prisma/client")) {
    return { url: new URL("./index.js", `file://${testClient}/`).href, shortCircuit: true };
  }
  if (
    specifier.startsWith("./") ||
    specifier.startsWith("../")
  ) {
    const base = new URL(specifier, context.parentURL);
    if (!base.pathname.match(/\.[a-z0-9]+$/i)) {
      for (const ext of EXTENSIONS) {
        const candidate = base.href + ext;
        try {
          if (existsSync(new URL(candidate))) {
            return { url: candidate, shortCircuit: true };
          }
        } catch {
          // not a file URL we can stat — fall through
          break;
        }
      }
    }
  }
  return nextResolve(specifier);
}
