import { AUTO_APPLY_SECTION } from './content/auto-apply';
import { AUTOFILL_SECTION } from './content/autofill';
import { CONTACT_SECTION } from './content/contact';
import { DOCUMENTS_SECTION } from './content/documents';
import { EXTENSION_SECTION } from './content/extension';
import { JOBS_SECTION } from './content/jobs';
import { MCP_SECTION } from './content/mcp';
import { PLANS_SECTION } from './content/plans';
import { SETTINGS_SECTION } from './content/settings';
import { SHARING_SECTION } from './content/sharing';
import { START_SECTION } from './content/start';
import { TRACKER_SECTION } from './content/tracker';
import type { GuideSection } from './model';

// v34 HELP (PLAN G6): the guide's sections in reading order. v35 OPSWEB (PLAN H8, the owner's "you don't need to add it
// to help or guide page"): no Admin section; the admin's pages keep their own "?" tips.
export const GUIDE_SECTIONS: readonly GuideSection[] = [
  START_SECTION,
  JOBS_SECTION,
  TRACKER_SECTION,
  AUTO_APPLY_SECTION,
  DOCUMENTS_SECTION,
  MCP_SECTION,
  EXTENSION_SECTION,
  AUTOFILL_SECTION,
  SETTINGS_SECTION,
  SHARING_SECTION,
  PLANS_SECTION,
  CONTACT_SECTION,
];
