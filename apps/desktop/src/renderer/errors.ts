/** A bridge failure without Electron's transport wording; the reason is what a person needs. */
export const errorMessage = (cause: unknown) =>
  (cause instanceof Error ? cause.message : String(cause)).replace(
    /^Error invoking remote method '[^']*': *([A-Za-z]*Error: )?/,
    '',
  )
