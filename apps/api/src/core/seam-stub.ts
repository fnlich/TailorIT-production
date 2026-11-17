// v30 SCH: what a wave-3 seam's stub throws until its package builds it (core/seams.ts lists each seam, its contract and
// its builder). A stub file holds one `// v30 stub` mark; INT-3 wires the built seams and finds what is left with
// `grep -rn "v30 stub"`. A package that calls another's seam fakes it in its tests until then (core/seams.ts says how).

/** A seam called before its package built it. */
export class SeamNotBuiltError extends Error {
  readonly seam: string;
  readonly builder: string;
  constructor(seam: string, builder: string) {
    super(`The ${seam} seam is not built yet: ${builder} builds it (INT-3 wires it). Fake it in tests until then.`);
    this.name = 'SeamNotBuiltError';
    this.seam = seam;
    this.builder = builder;
  }
}
