// Resumes: the section catalogue and order rules, the document schema and normaliser, display helpers, JSON
// import/export, what TailorIT reads from a resume (analysis contracts, years of experience, the rule-based reading)
// and the endpoint contracts.
export * from './catalogue';
export * from './document';
export * from './normalize';
export * from './display';
export * from './transfer';
export * from './analysis';
export * from './years';
export * from './analyze';
export * from './dto';
export * from './inline';
export * from './period';
export * from './fonts';
export * from './templates';
export * from './design';
export * from './entryIds';
export * from './toggles';
export * from './layout';
export * from './download';
export * from './printed';
// v20 P10 (A28): Documents' batch resume download, Paid only.
export * from './batch-download';
// v32 FILL: "Fill from my resume" as Settings reads it (the autofill contract's seed, wrapped).
export * from './profile-seed';
