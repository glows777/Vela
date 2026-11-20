/** Vela motion constants from design/app.md: two durations and two curves. */
export const velaMotion = {
  duration: {
    quick: 0.2,
    base: 0.3,
  },
  ease: {
    out: [0.16, 1, 0.3, 1] as const,
    snap: [0.2, 1.5, 0.35, 1] as const,
  },
} as const
