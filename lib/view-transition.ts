/**
 * Whether a data commit should be wrapped in a View Transition.
 *
 * Extracted because the decision was made inline, inside a 5-second poll, and
 * getting it wrong is not cosmetic: the page stopped rendering entirely.
 *
 * The failure it caused. Home commits its lineup by calling three setState
 * calls. To animate that, it wrapped them in document.startViewTransition and
 * ReactDOM.flushSync — behind a dynamic `import("react-dom")`, so the whole
 * thing fired from a promise callback at a moment React had not chosen, at
 * least once every five seconds, with no guard against a second transition
 * starting while the first was still running.
 *
 * flushSync renders synchronously. Calling it from outside React's own
 * scheduling re-enters the renderer while it may already be mid-render, and the
 * hook cursor goes out of step with the component. The next render then finds
 * fewer hooks recorded than it is about to call, and React throws #310 —
 * "Rendered more hooks than during the previous render" — on the component's
 * FIRST hook, which is why the stack pointed at useSession() in Home and
 * nowhere near the code that caused it.
 *
 * It only ever showed for signed-in listeners, which is what made it look like
 * an account problem rather than a rendering one: the poll returns early unless
 * the session is authenticated and approved, so a signed-out visitor never
 * reaches this code at all. Incognito worked. A signed-in profile did not.
 *
 * So the rules, stated once:
 *   - no flushSync. A view transition waits for the next frame anyway, so the
 *     setState calls inside its callback are applied in time without forcing a
 *     synchronous render from the outside.
 *   - one transition at a time. A second commit while the first is still
 *     running applies directly, which is exactly what happened before the
 *     transition existed and was never wrong — only slower to look at.
 */

/** Mutable because the "is one running" fact is per-render-loop, not per-commit. */
export interface ViewTransitionGate {
  inFlight: boolean;
}

export function newGate(): ViewTransitionGate {
  return { inFlight: false };
}

export function shouldAnimateCommit(args: {
  /** False when nothing visible changed — no point snapshotting identical DOM. */
  animate: boolean;
  /** A hidden tab cannot transition; the call throws InvalidStateError. */
  hidden: boolean;
  /** Older Safari and Chrome have no View Transitions at all. */
  supported: boolean;
  gate: ViewTransitionGate;
}): boolean {
  return args.animate && !args.hidden && args.supported && !args.gate.inFlight;
}

/** Claim the single transition slot. False when one is already running. */
export function beginCommit(gate: ViewTransitionGate): boolean {
  if (gate.inFlight) return false;
  gate.inFlight = true;
  return true;
}

/** Release the slot. Safe to call twice, so a rejected transition cannot wedge it. */
export function endCommit(gate: ViewTransitionGate): void {
  gate.inFlight = false;
}
