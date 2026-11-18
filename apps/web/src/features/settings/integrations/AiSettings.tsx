'use client';

import { CustomInstructionsSetting } from './CustomInstructionsSetting'; // v2.0
import { IntegrationSection } from './IntegrationSection';
import { AI_COPY } from './integrations';
import { HOW_IT_WORKS } from './mcp';
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

/** "How it works". */
export function HowItWorks() {
  return (
    <div className="rounded-control bg-surface-low px-4 py-3.5 text-sm leading-5 text-foreground">
      <p className="font-semibold">How it works</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
        {HOW_IT_WORKS.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
