// Relevant successful Bun output from the pre-fix cd-task faux transcripts.
export const savedTestRuns = [
  {
    source: 'C2/old/cd-task',
    target: 'task/limits.test.ts',
    output: {
      kind: 'vela-tool-result',
      preview:
        '[2026-10-26T14:13:03.544Z]\nbun test v1.4.2 (744846f84)\n\nlimits.test.ts:\n(pass) default batch size [0.04ms]\n\n 1 pass\n 0 fail\n 1 expect() calls\nRan 1 test across 1 file. [4.00ms]\n',
    },
  },
  {
    source: 'C6/old/cd-task',
    target: 'task/total.test.ts',
    output: {
      kind: 'vela-tool-result',
      preview:
        '[2026-10-26T14:13:03.669Z]\nbun test v1.4.2 (744846f84)\n\ntotal.test.ts:\n(pass) empty and mixed [0.41ms]\n\n 1 pass\n 0 fail\n 2 expect() calls\nRan 1 test across 1 file. [4.00ms]\n',
    },
  },
  {
    source: 'C2/new/cd-task',
    target: 'task/limits.test.ts',
    output:
      'bun test v1.4.2 (744846f84)\n\nlimits.test.ts:\n(pass) default batch size [0.04ms]\n\n 1 pass\n 0 fail\n 1 expect() calls\nRan 1 test across 1 file. [3.00ms]\n',
  },
  {
    source: 'C6/new/cd-task',
    target: 'task/total.test.ts',
    output:
      'bun test v1.4.2 (744846f84)\n\ntotal.test.ts:\n(pass) empty and mixed [0.25ms]\n\n 1 pass\n 0 fail\n 2 expect() calls\nRan 1 test across 1 file. [4.00ms]\n',
  },
] as const
