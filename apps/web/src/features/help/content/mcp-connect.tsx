'use client';

import { MCP_PATH, MCP_SERVER_NAME } from '@tailorit/shared/mcp';
import { connectSnippets, useMcpAddressHere } from '../address';
import { useGuide } from '../context';
import { AppPage, Aside, Bullets, Code, CodeBlock, CopyButton, P, See, Steps, Ui } from '../parts';
import { TOOL_EFFECT_LABEL } from '../tools';

// v34 HELP: Use TailorIT from your AI, part 1: what your AI can and cannot do, and connecting Claude, ChatGPT, Claude
// Code and other MCP clients (CLAUDE-DOCS.md: from Claude's directory once listed, or as a custom connector today).
// Review #1: what your AI sees is stated as the code sends it (first names, a resume as written for an editable copy
// or a letter; never sensitive answers or passwords). Review #3: two ways to add the connector, then the same steps.

/** Claude's connector settings, where Integrations' own Connect sends you (packages/shared/src/oauth claudeConnectorLink). */
const CLAUDE_CONNECTORS = 'claude.ai/customize/connectors';

/** The MCP address as the guide shows it, with its copy button, and a word when Claude cannot reach it. */
export function AddressLine() {
  const { address, reachable } = useMcpAddressHere();
  return (
    <div className="flex min-w-0 flex-col gap-1" data-mcp-address="">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-sm leading-6 font-semibold text-foreground">TailorIT&apos;s MCP address:</span>
        {address ? (
          <>
            <Code>{address}</Code>
            <CopyButton text={address} label="Copy TailorIT's MCP address" />
          </>
        ) : (
          <span className="text-sm leading-6 text-foreground">
            this site&apos;s address followed by <Code>{MCP_PATH}</Code>
          </span>
        )}
      </div>
      {reachable === false && (
        <p className="text-sm leading-6 text-muted-foreground" data-mcp-unreachable="">
          This is not a public https address, so Claude and ChatGPT cannot reach it: connect with a personal token instead (
          <See to="mcp-tokens">Claude Code and other clients</See>).
        </p>
      )}
    </div>
  );
}

export function CanAndCannot() {
  const { t } = useGuide();
  return (
    <>
      <P>
        TailorIT runs an <Ui>MCP server</Ui>: a standard way for AI apps to use another service&apos;s tools. Connect your AI
        app once, then ask in your own words. Your AI picks TailorIT&apos;s tools itself, and TailorIT answers it with small
        tables, a page at a time, so it stays quick even with a million jobs.
      </P>
      <P>Your AI can:</P>
      <Bullets>
        <li>find jobs among every job TailorIT holds, by words, posting date, place, remote, seniority, years asked, pay, clearance, visa sponsorship and application system;</li>
        <li>add a job from its link, save jobs to your Job Tracker, and archive saved ones;</li>
        <li>tell you how your applications stand: how many, in which stage, on which platform, week by week;</li>
        <li>look after the auto-apply queue: what is waiting, what needs you, and take jobs out;</li>
        <li>
          <Ui>Prepare &amp; Queue</Ui> your saved jobs, writing each kit (the tailored resume, the cover letter, the answers) on
          your own AI plan, while TailorIT checks, stores and queues it;
        </li>
        <li>write a cover letter for a saved job, or a resume tailored for one job, in TailorIT&apos;s place;</li>
        <li>
          change your AI settings when you ask (revision rounds, prompts, letters); new custom instructions from your AI wait
          for your OK in Integrations;
        </li>
        <li>
          do the same on the profiles other people share with you, as far as the boxes they ticked allow (your AI settings stay
          your own).
        </li>
      </Bullets>
      <P>
        It can also save, archive or add jobs on several profiles in one go, read the Prepare filters of any of them, and
        change those filters (on one, several or all profiles) when you ask.
      </P>
      <P>Your AI cannot:</P>
      <Bullets>
        <li>apply to jobs: the TailorIT browser extension applies; your AI can only queue prepared jobs;</li>
        <li>delete applications or documents (unsaving archives), upload files, or change your account, sharing, tokens or connected apps;</li>
        <li>
          see your sensitive answers (self-identification, work authorization, disability, veteran status, pay), your
          job-site passwords or your sign-in codes: TailorIT never sends them, and refuses an answer that states one;
        </li>
        <li>decide which jobs fit you: which jobs are prepared comes only from your Prepare filters, or the jobs you name;</li>
        <li>use TailorIT&apos;s own AI, apart from AI job search on a Paid account.</li>
      </Bullets>
      <P>
        What it does see is in <See to="mcp-limits">Limits, privacy and tokens</See>. On someone else&apos;s profile it needs
        their <Ui>{t('LABEL_SHARING_ROW_MCP')}</Ui> box.
      </P>
    </>
  );
}

export function ConnectClaude() {
  const { frame } = useGuide();
  return (
    <>
      <AddressLine />
      <P>
        Claude (on the web, the desktop app and the phone apps) connects through TailorIT&apos;s own sign-in and consent page:
        nothing to copy but the address. It reaches TailorIT from the internet, so the address must be a public https
        address; a TailorIT on your own computer only (localhost) connects with a personal token instead (see{' '}
        <See to="mcp-tokens">Claude Code and other clients</See>).
      </P>
      <P>Add TailorIT to Claude one of two ways:</P>
      <Bullets>
        <li>
          <Ui>From Claude&apos;s connector directory</Ui> (once TailorIT is listed there): in Claude open Customize ›
          Connectors (<Code>{CLAUDE_CONNECTORS}</Code>), browse the connectors, find TailorIT and choose <Ui>Connect</Ui>.
        </li>
        <li>
          <Ui>As a custom connector</Ui>: in TailorIT open <AppPage href="/settings/integrations">Integrations</AppPage> ›{' '}
          <Ui>AI assistants</Ui>, choose <Ui>Connect</Ui> on Claude, then <Ui>Open Claude</Ui>: Claude&apos;s{' '}
          <Ui>Add custom connector</Ui> window opens with TailorIT&apos;s name and address filled in. Or, in Claude, open
          Customize › Connectors › <Ui>Add custom connector</Ui>, name it TailorIT and paste the address. Leave the advanced
          settings as they are: Claude shows <Ui>Use Claude&apos;s published identity</Ui>, so it needs no client ID or secret.
          Choose <Ui>Add</Ui>.
        </li>
      </Bullets>
      <P>Then:</P>
      <Steps>
        <li>
          Claude sends you to TailorIT. If Claude&apos;s connector list shows TailorIT as <Ui>Not connected</Ui> instead, open
          it there and choose <Ui>Connect</Ui>.
        </li>
        <li>
          Sign in if TailorIT asks. The consent page names the app, where it sends you back to and what it may do with your
          account. Choose <Ui>Allow</Ui>.
        </li>
        {/* v34 FIX-COPY (final review G-L2 = dir D7): prepare_start and prepare_mark are marked destructive too. */}
        <li>
          Back in Claude, TailorIT&apos;s tools are in the chat&apos;s tools menu. Tools that only read run without asking.
          Claude asks you first, unless you allow a tool always, before tools that archive, remove or overwrite your data
          and before Prepare &amp; Queue starts or a Prepare is ended: each is marked{' '}
          <Ui>{TOOL_EFFECT_LABEL.removes}</Ui> in the tool reference.
        </li>
        <li>
          Try a first request: &quot;Read TailorIT&apos;s rules first, then tell me what you can do here.&quot; (more in{' '}
          <See to="mcp-prompts">How to ask</See>).
        </li>
      </Steps>
      <P>
        On a Team or Enterprise plan an owner adds TailorIT once in the organization&apos;s connector settings (Integrations
        links there); then each member chooses Connect in Claude.{' '}
        {frame === 'app' ? (
          <>
            <AppPage href="/settings/integrations">Integrations</AppPage> › <Ui>Connected</Ui> lists every app you allowed,
            with when it was last used; <Ui>Disconnect</Ui> cuts one off at once.
          </>
        ) : (
          <>
            Integrations › <Ui>Connected</Ui> lists every app you allowed; <Ui>Disconnect</Ui> cuts one off at once.
          </>
        )}
      </P>
    </>
  );
}

export function ConnectChatGpt() {
  return (
    <>
      <AddressLine />
      <Steps>
        <li>
          In <AppPage href="/settings/integrations">Integrations</AppPage> › <Ui>AI assistants</Ui> choose <Ui>Connect</Ui> on
          ChatGPT, then <Ui>Copy address and open ChatGPT</Ui>.
        </li>
        <li>
          On ChatGPT&apos;s plugins page choose <Ui>+</Ui> and <Ui>Add custom MCP server</Ui>. Name it TailorIT, paste the
          address, choose OAuth, accept the warning and choose <Ui>Create</Ui>; then install it.
        </li>
        <li>
          ChatGPT sends you to TailorIT&apos;s consent page: sign in if asked and choose <Ui>Allow</Ui>.
        </li>
        <li>
          In a chat, type <Code>@</Code> and choose TailorIT.
        </li>
      </Steps>
      <P>Your ChatGPT plan or workspace must allow custom MCP servers. As with Claude, the address must be a public https address.</P>
    </>
  );
}

export function ConnectWithToken() {
  const { address } = useMcpAddressHere();
  const snippets = connectSnippets(address ?? `https://your-tailorit-address${MCP_PATH}`);
  return (
    <>
      <P>
        Claude Code, Claude Desktop and other MCP clients you run yourself connect with a <Ui>personal access token</Ui>.
        They also work with a TailorIT that runs only on your computer.
      </P>
      <Steps>
        <li>
          Open <AppPage href="/settings/integrations">Integrations</AppPage>, then <Ui>Advanced: personal access tokens</Ui> at
          the end of AI assistants. Name a token (for example &quot;Claude Code&quot;) and make it. Copy it right away:
          TailorIT shows it only once.
        </li>
        <li>
          Add TailorIT to your client with your token in place of <Code>tim_your_token</Code>. The page shows both snippets
          with your token and address already in them.
        </li>
      </Steps>
      <CodeBlock title="Claude Code" text={snippets.claudeCode} />
      <P>
        Then <Code>claude mcp list</Code> shows <Code>{MCP_SERVER_NAME}</Code> connected. In Claude Code you can also run
        TailorIT&apos;s prompt <Code>/mcp__{MCP_SERVER_NAME}__prepare_all</Code>. Claude Code can also sign in through
        TailorIT&apos;s consent page instead of a token: add the address without the header, run <Code>/mcp</Code> in Claude
        Code and choose to authenticate.
      </P>
      <CodeBlock title="Claude Desktop and other clients (mcpServers)" text={snippets.config} />
      <P>
        Add it under <Code>mcpServers</Code> in the client&apos;s configuration (in Claude Desktop: Settings › Developer › Edit
        Config), save, then quit the client completely and open it again. It runs a small bridge with <Code>npx</Code>, so the
        computer needs Node.js. A client that connects to HTTP servers itself can use the address with the header{' '}
        <Code>Authorization: Bearer tim_your_token</Code> instead.
      </P>
      <Aside title="Keep tokens safe">
        <P>
          A token can do everything your AI can on your account. It is stored hashed, works until you revoke it, and reaches
          only the MCP address. Revoke it in Integrations to cut a client off at once; what it saved stays.
        </P>
      </Aside>
    </>
  );
}
