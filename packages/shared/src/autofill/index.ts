// The contract between TailorIT and its browser extension, TailorIT Autofill: the /api/autofill/* schemas, imported as
// `@tailorit/shared/autofill`. Not in the package's root barrel, whose names it would clash with. The extension copies
// this folder's non-test files byte for byte, so they import only zod and each other; `npm run autofill:contract`
// records their hashes and JSON Schemas beside the examples in packages/shared/contract/autofill/v1/, and
// apps/api/test/autofill-contract.test.ts keeps the three in step.
export * from './version';
export * from './common';
export * from './resumes';
export * from './profile';
export * from './connect';
export * from './lookup';
export * from './tracker';
export * from './ai';
export * from './answers';
export * from './cover-letters';
export * from './sites';
export * from './agent';
export * from './credentials';
// v1.4 D: tailoring a resume and a cover letter for a job.
export * from './tailor';
export * from './forms';
export * from './registry';
// v30 CT (version 9): the closed-link reports and their closed lists.
export * from './closed';
