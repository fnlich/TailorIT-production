'use client';

import { MCP_TOOL_CATALOG } from '@tailorit/shared/mcp-catalog';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { useBoxName } from '../boxes';
import { useGuide } from '../context';
import { EXAMPLE_PROMPTS, PROMPT_TASKS, namesProfile } from '../prompts';
import { TOOL_EFFECT_LABEL, toolEffect, toolsByGroup, type ToolEffect, type ToolRow } from '../tools';
import { Code, CopyButton, Minor, P, Ui } from '../parts';

// v34 HELP: the example prompts (prompts.ts, each checked against the server's tools by help.test.ts) and the tool
// reference (the server's own tools/list, @tailorit/shared/mcp-catalog, with tools.ts' words for people).

/** The example prompts, by task: what you type (with a copy button), what happens, and the tools it uses. */
export function PromptList() {
  return (
    <div className="flex flex-col gap-6" data-prompt-list="">
      {PROMPT_TASKS.map((task) => {
        const prompts = EXAMPLE_PROMPTS.filter((prompt) => prompt.task === task.id);
        if (prompts.length === 0) return null;
        return (
          <div key={task.id} className="flex flex-col gap-3">
            <Minor>{task.title}</Minor>
            <ul className="flex flex-col gap-3">
              {prompts.map((prompt) => (
                <li key={prompt.id} id={`prompt-${prompt.id}`} data-example-prompt={prompt.id} className="rounded-control border border-border bg-surface px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 text-sm leading-6 font-semibold text-foreground">&ldquo;{prompt.text}&rdquo;</p>
                    <CopyButton text={prompt.text} label={`Copy the prompt: ${prompt.text}`} />
                  </div>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">{prompt.result}</p>
                  <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs leading-5 text-muted-foreground">
                    <span>Uses</span>
                    {Object.keys(prompt.tools).map((tool) => (
                      <Code key={tool}>{tool}</Code>
                    ))}
                    {namesProfile(prompt) && <Badge tone="sky">On a shared profile</Badge>}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

const EFFECT_TONE: Readonly<Record<ToolEffect, BadgeTone>> = { reads: 'success', 'uses-ai': 'sky', changes: 'warning', removes: 'destructive' };

function ToolItem({ tool }: { tool: ToolRow }) {
  const boxName = useBoxName();
  const effect = toolEffect(tool);
  const box = boxName(tool.sharedBox);
  return (
    <li data-tool={tool.name} className="flex flex-col gap-1 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm leading-6 font-semibold text-foreground">{tool.title}</span>
        <Code>{tool.name}</Code>
      </div>
      <p className="text-sm leading-6 text-foreground">{tool.summary}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={EFFECT_TONE[effect]}>{TOOL_EFFECT_LABEL[effect]}</Badge>
        {tool.annotations.openWorldHint === true && <Badge tone="outline">Reads the posting&apos;s page</Badge>}
        {tool.profile ? (
          <Badge tone="tint">Any of your profiles</Badge>
        ) : tool.name === 'prepare_queue' ? (
          <Badge tone="tint">Every profile at once</Badge>
        ) : (
          <Badge tone="neutral">Your own account</Badge>
        )}
        {box && <span className="text-xs leading-5 text-muted-foreground">On a shared profile: {box}</span>}
      </div>
    </li>
  );
}

/** Every tool of the server, under its group. */
export function ToolReference() {
  const { t } = useGuide();
  const groups = toolsByGroup();
  const total = MCP_TOOL_CATALOG.tools.length;
  return (
    <div className="flex flex-col gap-5" data-tool-reference="">
      {/* v34 FIX-COPY (final review G-L3, dir D6 and D7): what each badge means, as the tools' hints say. */}
      <P>
        TailorIT&apos;s MCP server has {total} tools. This list is made from the server&apos;s own list of tools, so it always
        matches what your AI sees. <Ui>{TOOL_EFFECT_LABEL.reads}</Ui> tools never change anything.{' '}
        <Ui>{TOOL_EFFECT_LABEL['uses-ai']}</Ui> (AI job search) changes nothing either, but each call counts toward your AI
        use. Tools marked <Ui>{TOOL_EFFECT_LABEL.changes}</Ui> save, add or record something, and your AI app may ask you
        before it uses them. Claude asks you first, unless you allow a tool always, before a tool marked{' '}
        <Ui>{TOOL_EFFECT_LABEL.removes}</Ui>: it archives, removes or overwrites your data, or starts or ends a Prepare. On a
        profile someone shared with you, each tool also needs the box named here, as well as the owner&apos;s{' '}
        <Ui>{t('LABEL_SHARING_ROW_MCP')}</Ui> box.
      </P>
      {groups.map((group) => (
        <div key={group.id}>
          <Minor>{group.title}</Minor>
          <ul className="divide-y divide-border">
            {group.tools.map((tool) => (
              <ToolItem key={tool.name} tool={tool} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** The server's MCP prompts: what an app may offer as commands. */
export function ServerPrompts() {
  return (
    <>
      <P>
        Some AI apps also offer the server&apos;s <Ui>prompts</Ui> as commands (in Claude Code, type <Code>/</Code>):
      </P>
      <ul className="flex flex-col gap-1.5 text-sm leading-6 text-foreground" data-server-prompts="">
        {MCP_TOOL_CATALOG.prompts.map((prompt) => (
          <li key={prompt.name} className="flex flex-wrap items-center gap-2">
            <Code>{prompt.name}</Code>
            <span>
              {prompt.title}
              {prompt.arguments.length > 0 ? ` (asks for ${prompt.arguments.join(', ')})` : ''}
            </span>
          </li>
        ))}
      </ul>
      <P>
        <Code>prepare_all</Code> gives your AI TailorIT&apos;s rules and starts Prepare &amp; Queue on your saved jobs; the
        others are the steps of one job&apos;s kit, for a job id from the Prepare queue.
      </P>
    </>
  );
}
