/**
 * Module-level navigation guard registry, the hash-router counterpart to the
 * modal counter in Modal.tsx. Pages with unsaved state register a guard; the
 * Android back-button handler in main.tsx consults it before history.back().
 *
 * A guard returns true when it handled the back intent itself (typically by
 * opening a confirm dialog) and false to let normal navigation proceed, so a
 * clean form costs nothing. Guards form a stack: the most recently registered
 * one wins, which is the innermost mounted page.
 *
 * react-router v7 with a plain <HashRouter> has no useBlocker, so in-app
 * back *links* cannot use this registry automatically; pages intercept their
 * own header links and reuse the same confirm dialog.
 */

export type NavigationGuard = () => boolean;

const guards: NavigationGuard[] = [];

/** Returns an unregister function; call it on unmount. */
export function registerNavigationGuard(guard: NavigationGuard): () => void {
  guards.push(guard);
  return () => {
    const i = guards.indexOf(guard);
    if (i !== -1) guards.splice(i, 1);
  };
}

/** True if a guard consumed the back action (navigation must not happen). */
export function runNavigationGuards(): boolean {
  for (let i = guards.length - 1; i >= 0; i--) {
    if (guards[i]()) return true;
  }
  return false;
}
