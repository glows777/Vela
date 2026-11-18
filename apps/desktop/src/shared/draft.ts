/** A rejected submission returns its own text, and anything typed since stays below it. */
export const restoreDraft = (submitted: string, current: string) =>
  current === '' ? submitted : `${submitted}\n${current}`
