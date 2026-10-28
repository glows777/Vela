/**
 * Dollar amount shared by the footer, `/status` and `/usage`.
 * Four decimals: three (the footer's old rounding) turns `$0.0016` into `$0.002`,
 * so the overview and the footer would disagree about the same session.
 */
export function formatUsd(amount: number): string {
  return `$${amount.toFixed(4)}`
}
