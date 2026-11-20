export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Keep the original diagnostic in the operator log and give the chat a safe recovery action. */
export class WorkspacePreparationError extends Error {
  constructor(cause: unknown) {
    super(
      'Could not prepare this input for its configured workspace. Ask the operator to check the environment and retry.',
      { cause },
    )
  }
}

export function feedbackFailure(error: unknown) {
  if (error instanceof WorkspacePreparationError)
    return {
      diagnostic: errorMessage(error.cause),
      eventError: new Error(error.message),
      text: error.message,
    }
  const diagnostic = errorMessage(error)
  return {
    diagnostic,
    eventError: error,
    text: `Couldn't update task feedback: ${diagnostic}. Check the bot's permissions and connection.`,
  }
}
