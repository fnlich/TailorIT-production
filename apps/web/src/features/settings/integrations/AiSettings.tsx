'use client';

import { InfoIcon } from '../../../components/ui/icons';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '../../../components/ui/Popover';
import { CustomInstructionsSetting } from './CustomInstructionsSetting'; // v2.0
import { IntegrationSection } from './IntegrationSection';
import { AI_COPY } from './integrations';
import { HOW_IT_WORKS } from './mcp';
import { ALSO_ASK } from './unsupported';
import { ReviseRoundsSetting } from './ReviseRoundsSetting'; // v1.5 Q1

/**
 * AI assistants › "How your AI works with TailorIT" (v3.1 INTEG; v1.5 M's "Your own AI (MCP)" section without its
 * tokens): what the person's own AI does through TailorIT, and the settings every connected AI gets (Claude and
 * ChatGPT through OAuth, the clients with a personal token): the revision rounds and the custom instructions.
 */
export function AiSettings() {
  return (
    <IntegrationSection title={AI_COPY.settingsTitle} description={AI_COPY.settingsDescription}>
      <HowItWorks />
      <ReviseRoundsSetting />
      <CustomInstructionsSetting />
    </IntegrationSection>
  );
}

/**
 * "How it works": v32 FIX-UX (UXREQ-8: a tip is one sentence, and a label with nothing under it is no row): a quiet
 * button that opens a popover of the steps and of what else the person's AI can do through TailorIT (as Auto-apply's
 * "How auto-apply works"), not a "?" of five sentences.
 */
export function HowItWorks() {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex h-9 items-center gap-1.5 self-start rounded-control px-2 text-sm font-medium text-primary underline-offset-2 hover:underline max-sm:min-h-11"
            data-how-it-works=""
          />
        }
      >
        <InfoIcon size={16} aria-hidden="true" />
        {HOW_IT_WORKS_TITLE}
      </PopoverTrigger>
      <PopoverContent className="w-[min(28rem,calc(100vw-2rem))]" align="start">
        <PopoverTitle>{HOW_IT_WORKS_TITLE}</PopoverTitle>
        <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-[13px] leading-5 text-foreground">
          {HOW_IT_WORKS.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="mt-3 text-[13px] leading-5 font-semibold text-foreground">{ALSO_ASK_TITLE}</p>
        <ul className="mt-1.5 flex list-disc flex-col gap-1.5 pl-5 text-[13px] leading-5 text-foreground" data-also-ask="">
          {ALSO_ASK.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/** The popover's button and title. */
export const HOW_IT_WORKS_TITLE = 'How it works';
/** What else the AI can do, the popover's second part (it was a label row in "Requests your AI could not do"). */
export const ALSO_ASK_TITLE = 'Your AI can also';
