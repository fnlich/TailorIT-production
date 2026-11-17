// v2.0: the central constants, also exported from @tailorit/shared (02-constants.md).
export * from './constants';
export * from './kinds';
export * from './render';
export * from './day';
export * from './api';
// v20 FIX-A (SEC-5): the generator of ./public/specs.ts (the web's test compares the file with it).
export * from './public-gen';
// v30 CT: the words of the shared contracts' own checks (the API sets them from its constants service).
export * from './public/defaults';
