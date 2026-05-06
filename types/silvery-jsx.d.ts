/**
 * Ambient JSX type declarations for @silvery/ag-react.
 *
 * The @silvery/ag-react package ships .tsx components that reference
 * `silvery-box` and `silvery-text` host elements via their custom React
 * reconciler. TypeScript can't infer these from the package itself
 * (the reconciler API doesn't expose IntrinsicElements augmentation),
 * so we declare them here.
 *
 * Without this, `bun run typecheck` reports 30+ TS2339 errors when it
 * tries to type-check the package's source files (skipLibCheck does
 * not engage on .tsx files imported through the package boundary in
 * 2025-2026 toolchains; tracked upstream).
 *
 * If the upstream package adds proper JSX intrinsic typing (or moves
 * the host primitives into a typed registry), delete this file.
 */

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "silvery-box": Record<string, unknown>;
      "silvery-text": Record<string, unknown>;
    }
  }
}

export {};
