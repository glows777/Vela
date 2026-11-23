/** Files and images above this size are rejected before they can occupy the process. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/** A Lark attachment exceeded MAX_ATTACHMENT_BYTES. */
export class FileTooLarge extends Error {}
