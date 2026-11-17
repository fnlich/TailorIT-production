// v3.0 FIX-INT (REV-REQ REQ-14, the one-source rule): the lengths of a minute, an hour and a day in milliseconds,
// declared once here and imported by every product file of the API, the web and the shared packages
// (apps/api/test/structure-time-units.test.ts fails on another declaration). A day here is 24 hours of elapsed time;
// the calendar day a reset time starts (the day key of the AI budgets and the daily caps) is constants/day.ts's.

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
