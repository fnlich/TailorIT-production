'use client';

import { MCP_PATH } from '@tailorit/shared/mcp';
import { OAUTH_PROTECTED_RESOURCE_PATH } from '@tailorit/shared/oauth';
import { useSyncExternalStore, type ReactNode } from 'react';
import { usePublicConstants } from '@/lib/constants';
import { ContactAddress, useOperator } from './OperatorParts';
import { GUIDE_ANCHORS, guideLink } from './paths';
import { PolicyPage, PolicySection, sectionOf } from './PolicyPage';
import { B, Bullets, Code, P, TextLink } from './prose';

// v34 PUBLIC (PLAN G8; an AI directory asks for a support channel and troubleshooting): how to get help, where the User
// Guide explains things, and what to check when an AI app will not connect. The three messages are Claude's own words
// for a connector that fails (claude.com/docs/connectors/building/troubleshooting, read 2026-11-21); what to check is
// TailorIT's. The contact address is ADMIN_CONTACT_EMAIL.

export const SUPPORT_SECTIONS = [
  { id: 'help', title: 'Get help' },
  { id: 'guide', title: 'In the User Guide' },
  { id: 'connect', title: 'Connecting an AI app' },
  { id: 'unreachable', title: "Couldn't reach the MCP server" },
  { id: 'authorization', title: 'Authorization with the MCP server failed' },
  { id: 'tool-error', title: 'Unexpected error while invoking tool' },
  { id: 'other', title: 'Other common problems' },
] as const;

const at = (id: (typeof SUPPORT_SECTIONS)[number]['id']) => sectionOf(SUPPORT_SECTIONS, id);

/**
 * v34 FIX-COPY (final review dir D10): Claude shows a reference with a connector's error (it starts with ofid_), which
 * finds that request in Claude's own records (CLAUDE-DOCS: the bug tracker asks for it); a report to support carries it.
 */
export const OFID_LINE = 'If Claude showed a reference with the error (it starts with ofid_), include it.';

/** The MCP endpoint's metadata document: a quick check that TailorIT answers on an address. */
const DISCOVERY_PATH = OAUTH_PROTECTED_RESOURCE_PATH;

/** The address never changes while the page is open: nothing to subscribe to. */
const subscribeNever = () => () => {};
/** This site's address in the browser; null on the server (the prerendered page names no address). */
function useSiteOrigin(): string | null {
  return useSyncExternalStore(
    subscribeNever,
    () => window.location.origin,
    () => null,
  );
}

/** A troubleshooting entry: what the message means, then what to check, in order. */
function Trouble({ means, checks }: { means: ReactNode; checks: ReactNode[] }) {
  return (
    <>
      <P>
        <B>What it means:</B> {means}
      </P>
      <P>
        <B>What to check:</B>
      </P>
      <Bullets>
        {checks.map((check, index) => (
          <li key={index}>{check}</li>
        ))}
      </Bullets>
    </>
  );
}

export function SupportPage() {
  const operator = useOperator();
  const origin = useSiteOrigin();
  const { get } = usePublicConstants();
  const mcpAddress = origin ? `${origin}${MCP_PATH}` : null;
  const mcpOnPlans = get('FREE_MCP') && get('PAID_MCP');

  return (
    <PolicyPage
      title="Support"
      testId="support"
      sections={SUPPORT_SECTIONS}
      lead={
        <P>
          Help with TailorIT: how to reach us, where the User Guide explains each feature, and what to check when an AI app
          such as Claude does not connect.
        </P>
      }
    >
      <PolicySection section={at('help')}>
        <P>
          <ContactAddress state={operator} />
        </P>
        <P>
          Say what you were doing, the address of the page, and when it happened. {OFID_LINE} Never send a password, a
          sign-in code or an access token: we never ask for them.
        </P>
      </PolicySection>

      <PolicySection section={at('guide')}>
        <Bullets>
          <li>
            <TextLink href={guideLink(GUIDE_ANCHORS.start)}>Getting started</TextLink>: your first steps in TailorIT.
          </li>
          <li>
            <TextLink href={guideLink(GUIDE_ANCHORS.mcp)}>Use TailorIT from your AI</TextLink>: what a connected AI app can
            and cannot do.
          </li>
          <li>
            <TextLink href={guideLink(GUIDE_ANCHORS.mcpConnect)}>Connect Claude</TextLink>, and after it ChatGPT and apps
            you run yourself.
          </li>
          <li>
            <TextLink href={guideLink(GUIDE_ANCHORS.mcpPrompts)}>How to ask</TextLink>: example requests that work.
          </li>
          <li>
            <TextLink href={guideLink(GUIDE_ANCHORS.mcpTroubleshooting)}>When your AI has trouble</TextLink>: limits and
            fixes.
          </li>
          <li>
            <TextLink href={guideLink(GUIDE_ANCHORS.extension)}>The browser extension</TextLink>: install it and connect it.
          </li>
        </Bullets>
      </PolicySection>

      <PolicySection section={at('connect')}>
        <P>
          An AI app reaches your account through TailorIT&apos;s MCP address. You find it in <B>Settings › Integrations</B>,
          with a <B>Connect</B> button for Claude and ChatGPT.{' '}
          {mcpAddress ? (
            <>
              On this site it is usually <Code>{mcpAddress}</Code>.
            </>
          ) : (
            <>It is usually this site&apos;s address followed by <Code>{MCP_PATH}</Code>.</>
          )}
        </P>
        <P>
          When you add TailorIT in Claude, Claude opens TailorIT so you can sign in and choose <B>Allow</B>. Sign in on the
          same address you gave Claude. Every connected app is listed in <B>Settings › Integrations</B>, where you can
          disconnect it.
        </P>
      </PolicySection>

      <PolicySection section={at('unreachable')}>
        <Trouble
          means="Claude could not get an answer from the address you gave it."
          checks={[
            <>
              The address is the MCP address from <B>Settings › Integrations</B>, exactly: it starts with{' '}
              <Code>https://</Code> and ends with <Code>{MCP_PATH}</Code>.
            </>,
            <>
              The address can be reached from the internet. Claude&apos;s apps connect from Anthropic&apos;s servers, so an
              address on your own computer or home network (such as <Code>localhost</Code>) works only with Claude Code on
              that same computer, and a firewall in front of TailorIT must let Anthropic&apos;s servers through.
            </>,
            <>
              Open <Code>{origin ? `${origin}${DISCOVERY_PATH}` : DISCOVERY_PATH}</Code> in your browser: a short document
              that starts with <Code>resource</Code> means TailorIT is answering on this address.
            </>,
            <>If the address changed (a test address often does), remove TailorIT in Claude and add it again with the new address.</>,
          ]}
        />
      </PolicySection>

      <PolicySection section={at('authorization')}>
        <Trouble
          means="Claude reached TailorIT, but you were not signed in there, or the connection was not approved."
          checks={[
            <>
              In the window Claude opens, sign in to TailorIT and choose <B>Allow</B>. If you choose <B>Cancel</B> or close
              the window, start again from Claude.
            </>,
            <>
              The address you gave Claude is the final one: if it changed, or forwards to another address, remove TailorIT
              in Claude and add it again with the current address.
            </>,
            <>
              If you disconnected the app in <B>Settings › Integrations</B>, connect again from Claude.
            </>,
            <>If TailorIT says it does not know the app, tell us when it happened (see Get help). {OFID_LINE}</>,
          ]}
        />
      </PolicySection>

      <PolicySection section={at('tool-error')}>
        <Trouble
          means="Claude is connected, but one request to TailorIT failed."
          checks={[
            <>Try the request again, or in a new chat.</>,
            <>
              In <B>Settings › Integrations</B> the app is still listed as connected. If it is not, connect it again.
            </>,
            mcpOnPlans ? (
              <>
                A limit of your plan may be reached for now: see <TextLink href={guideLink(GUIDE_ANCHORS.plans)}>Plans and
                limits</TextLink>.
              </>
            ) : (
              <>
                Your plan may not include using TailorIT from your AI, or a limit of your plan may be reached for now: see{' '}
                <TextLink href={guideLink(GUIDE_ANCHORS.plans)}>Plans and limits</TextLink>.
              </>
            ),
            <>
              <B>Requests your AI could not do</B>, in <B>Settings › Integrations</B>, lists what your AI asked for that
              TailorIT cannot do yet.
            </>,
            <>If it keeps happening, tell us the time and what you asked (see Get help). {OFID_LINE}</>,
          ]}
        />
      </PolicySection>

      <PolicySection section={at('other')}>
        <Bullets>
          <li>
            <B>A sign-in code did not arrive.</B> Look in your spam folder, wait a minute before asking for another one, and
            use the newest code: codes expire within minutes.
          </li>
          <li>
            <B>The browser extension does not connect.</B> In TailorIT, open <B>Autofill › Extension</B> and choose{' '}
            <B>Connect the extension</B> while you are signed in on the same site.
          </li>
          <li>
            <B>Something else.</B> Search the <TextLink href="/guide">User Guide</TextLink>, or write to us (see{' '}
            <TextLink href="#help">Get help</TextLink>).
          </li>
        </Bullets>
        <P>
          What TailorIT keeps about you, and how to have it deleted, is in the{' '}
          <TextLink href="/privacy">Privacy policy</TextLink>.
        </P>
      </PolicySection>
    </PolicyPage>
  );
}
