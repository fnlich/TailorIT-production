// v2.0: the central constants on the API (docs/design/v2.0/02-constants.md). The service is made by setupServices
// (app.ts) before every feature, as deps.services.constants, and its 60 s reload starts with startFeatures. Code reads
// it through constantsOf(deps), which also serves deps that were built without setupServices (scripts, unit tests).

export {
  CONSTANTS_RELOAD_MS,
  CONSTANT_SETTING_PREFIX,
  constantsOf,
  createConstantsService,
  loadConstants,
  type ConstantsService,
} from './service';
export { autoApplyWindow, dayKeyAt, nextDailyResetAt, resetTextOf, type AutoApplyWindow } from './day';
