import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { AiPrices } from '@tailorit/shared';
import type { AppConfig } from '../../config/env';
import type { Logger } from '../../core/log';
import type { AiCapacityService } from '../capacity';
import { aboutMinutes, AI_DETAILS, AiError, holdError } from '../errors';
import { buildClaudeArgv, isCliModelName, normalizeEffort, systemFileText } from './argv';
import { cliChannelParts, interpretTurn, type HoldRequest } from './classify';
import { apiKeyValues, buildChildEnv, scrubSecrets } from './env'; // v34 AIKEY: apiKeyValues, scrubSecrets
// v34 AIKEY: billedAgainst (AI_BILLING) instead of billedToKey.
import { billedAgainst, createTurnState, reduceEvent, streamedUsage, type RateLimitInfo, type TurnState } from './events';
import { probeCli, type CliStatus } from './health';
import { defaultResolveHost, resolveCliCommand, type CliCommand, type ResolveHost } from './resolve';
import { runCli, type CliRunOutcome } from './spawn';
import { lastLines } from './stream';
import type { AiProvider, CompletionRequest, CompletionResult, ProviderHold, RateLimitReading } from './types';

export const HEALTH_TIMEOUT_MS = 20_000;
export const HEALTH_CACHE_MS = 60_000;
/** v1.3 C: the folder, inside the CLI's work folder, that holds each call's system prompt file while it runs. */
export const SYSTEM_PROMPT_DIR = 'system-prompts';
/** A system prompt file left behind (a crash, a file the OS kept open) is deleted at the next start after this long. */
const STALE_SYSTEM_FILE_MS = 60 * 60_000;
/** A file the OS would not let go at once (a child still closing it, on Windows) is tried again after this long. */
const RETRY_DELETE_MS = 10_000;

// v34 AIKEY
/** `status` with the key's value scrubbed from every text the CLI gave (its version line, sign-in fields, a problem). */
function scrubStatus(status: CliStatus, hidden: readonly string[]): CliStatus {
  if (hidden.length === 0) return status;
  const scrub = (text: string | null) => (text === null ? null : scrubSecrets(text, hidden));
  return {
    ...status,
    version: scrub(status.version),
    authMethod: scrub(status.authMethod),
    subscriptionType: scrub(status.subscriptionType),
    apiKeySource: scrub(status.apiKeySource),
    problem: scrub(status.problem),
  };
}
// end v34 AIKEY

/** The usage reading in a turn's rate_limit_event (the CLI gives `resetsAt` in epoch seconds). */
function readingOf(info: RateLimitInfo, seenAtMs: number): RateLimitReading {
  const resetsAt = typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) ? info.resetsAt * 1000 : null;
  return {
    status: typeof info.status === 'string' ? info.status : '',
    resetsAtMs: resetsAt,
    usingOverage: info.isUsingOverage === true,
    seenAtMs,
  };
}

export interface ClaudeCliProviderOptions {
  ai: AppConfig['ai'];
  dataDir: string;
  log: Logger;
  /** The clock for holds and the health cache (tests freeze it). */
  now: () => Date;
  /** The environment the child's is derived from, read at every call. Default: process.env. */
  parentEnv?: () => NodeJS.ProcessEnv;
  resolveHost?: () => ResolveHost;
  /**
   * v2.0: hears the seat's usage each call reports (its rate_limit_event, and the limit texts in the CLI's own
   * channels), for the capacity block (ai/capacity.ts). Absent: nothing is told.
   */
  capacity?: Pick<AiCapacityService, 'noteEvent' | 'noteText'>;
  /** v2.0: AI_PRICES as resolved now, for a result that reports no cost. Default: the shipped table. */
  prices?: () => AiPrices;
}

/**
 * Runs completions through the locally installed, signed-in `claude` on the operator's subscription seat: one
 * process per call, the prompt on stdin, the answer read from stream-json. Every failure is an AiError.
 */
export function createClaudeCliProvider(options: ClaudeCliProviderOptions): AiProvider {
  const { ai, log } = options;
  // v34 AIKEY (PLAN Addendum G11): who pays, AI_BILLING. `subscription` (the default) keeps every key away from the CLI
  // and stops a call a key pays for; `api-key` passes ANTHROPIC_API_KEY and stops a call the subscription pays for.
  const billing = ai.billing;
  const workdir = join(options.dataDir, 'claude-cli-work');
  const systemDir = join(workdir, SYSTEM_PROMPT_DIR);
  const nowMs = () => options.now().getTime();
  const parentEnv = options.parentEnv ?? (() => process.env);
  /** v34 AIKEY: the key's value while it is passed, scrubbed from the CLI's own texts (its stderr, an error result). */
  const secrets = () => (billing === 'api-key' ? apiKeyValues(parentEnv()) : []);
  const holds = new Map<string, ProviderHold>();
  const warned = new Set<string>();
  let lastRate: RateLimitReading | null = null;
  let workdirReady = false;
  let resolved: { key: string; cli: CliCommand } | null = null;
  let statusCache: { at: number; value: CliStatus } | null = null;
  let probing: Promise<CliStatus> | null = null;

  const warnOnce = (key: string, message: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    log.warn(message);
  };

  /** Resolved once per (AI_CLI_BIN, PATH); re-resolved when the file it runs has gone (an upgrade, an uninstall). */
  function resolveCli(): CliCommand {
    const host = (options.resolveHost ?? defaultResolveHost)();
    const key = [ai.cliBin, host.pathEnv, host.pathExt].join('\u0000');
    const target = resolved && (resolved.cli.prefixArgs[0] ?? resolved.cli.command);
    if (resolved && resolved.key === key && target && (!isAbsolute(target) || host.isFile(target))) return resolved.cli;
    resolved = { key, cli: resolveCliCommand(ai.cliBin, host) };
    return resolved.cli;
  }

  /**
   * One fixed directory: the CLI keys per-project state on the working directory, and finds no CLAUDE.md there. v1.3 C:
   * its `system-prompts` folder holds each call's system prompt file (a person's facts and a job's text) while the call
   * runs; files an earlier run left behind are deleted the first time it is made ready.
   */
  function ensureWorkdir(): void {
    if (workdirReady) return;
    mkdirSync(systemDir, { recursive: true });
    const before = nowMs() - STALE_SYSTEM_FILE_MS;
    try {
      for (const name of readdirSync(systemDir)) {
        const file = join(systemDir, name);
        try {
          if (statSync(file).mtimeMs < before) rmSync(file, { force: true });
        } catch {
          /* gone already, or held: the next start tries again */
        }
      }
    } catch (error) {
      log.warn(`[ai] could not clear old system prompt files: ${(error as Error).message}`);
    }
    workdirReady = true;
  }

  /** v1.3 C: the call's system text in a file of its own (owner-only where the OS supports it), for --system-prompt-file. */
  function writeSystemFile(system: string): string {
    const file = join(systemDir, `system-${randomUUID()}.txt`);
    const write = () => writeFileSync(file, systemFileText(system), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      write();
    } catch (error) {
      // The folder went since it was made (cleared by hand): made again, once.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      mkdirSync(systemDir, { recursive: true });
      write();
    }
    return file;
  }

  /** Deletes a call's system file once the call is over; a file Windows still holds is tried again a little later. */
  function deleteSystemFile(file: string): void {
    try {
      rmSync(file, { force: true });
    } catch {
      const retry = setTimeout(() => {
        try {
          rmSync(file, { force: true });
        } catch (error) {
          log.warn(`[ai] could not delete a system prompt file (the next start will): ${(error as Error).message}`);
        }
      }, RETRY_DELETE_MS);
      retry.unref?.();
    }
  }

  /**
   * v2.0: the call's usage reports for the capacity block: its rate_limit_event, and the limit texts of the channels the
   * CLI writes (its stderr, an error result, the error marks), never a successful answer's text. Never fails the call.
   */
  function noteCapacity(outcome: CliRunOutcome, state: TurnState): void {
    const capacity = options.capacity;
    if (!capacity) return;
    try {
      if (state.rateLimit) capacity.noteEvent(state.rateLimit);
      if (outcome.spawnError) return;
      capacity.noteText(
        cliChannelParts({
          stderr: lastLines(outcome.stderr, 2000),
          isError: state.isError,
          resultText: state.resultText ?? '',
          errors: state.errors,
        }),
      );
    } catch (error) {
      log.warn('[ai] could not note what a call reported about the seat usage', error);
    }
  }

  /** v1.3 C: a model the CLI billed besides the one that answered (a side call), named once in the log. */
  function noteSideModels(models: readonly string[], answering: string): void {
    for (const model of models) {
      if (model !== answering) warnOnce(`side-model:${model}`, `[ai] the CLI also billed ${model} beside ${answering}.`);
    }
  }

  function holdFor(tag: string): ProviderHold | null {
    let longest: ProviderHold | null = null;
    for (const scope of ['*', tag]) {
      const hold = holds.get(scope);
      if (!hold) continue;
      if (hold.until <= nowMs()) holds.delete(scope);
      else if (!longest || hold.until > longest.until) longest = hold;
    }
    return longest;
  }

  function setHold(request: HoldRequest, tag: string): void {
    const scope = request.scope === '*' ? '*' : tag;
    const until = nowMs() + request.ms;
    const existing = holds.get(scope);
    if (existing && existing.until >= until) return;
    holds.set(scope, { scope, until, kind: request.kind, reason: request.reason });
    const what = scope === '*' ? 'all AI calls' : `AI calls for "${scope}"`;
    log.warn(`[ai] pausing ${what} for ${aboutMinutes(request.ms)}: ${request.reason}`);
  }

  async function complete(request: CompletionRequest): Promise<CompletionResult> {
    if (!request.ignoreHolds) {
      const hold = holdFor(request.tag);
      if (hold) throw holdError(hold, nowMs());
    }
    if (!isCliModelName(request.model)) {
      throw new AiError('modelUnavailable', { detail: `"${request.model}" is not a valid Claude model name.` });
    }
    let effort = normalizeEffort(request.effort);
    if (!effort) {
      const why = `[ai] effort "${request.effort}" is not low/medium/high/xhigh/max; using low.`;
      warnOnce(`effort:${request.effort}`, why);
      effort = 'low';
    }
    let cli: CliCommand;
    try {
      cli = resolveCli();
    } catch (error) {
      throw new AiError('unavailable', { message: AI_DETAILS.binaryMissing, detail: (error as Error).message });
    }
    ensureWorkdir();

    // v1.3 C (decision 10): the system text goes in a file, so however long it is it stays the system part (which the
    // CLI caches), and only the message goes on stdin.
    let systemFile: string;
    try {
      systemFile = writeSystemFile(request.system);
    } catch (error) {
      throw new AiError('unavailable', { detail: `The system prompt file could not be written: ${(error as Error).message}` });
    }
    const argv = buildClaudeArgv({
      model: request.model,
      effort,
      systemPromptFile: systemFile,
      fallbackModel: ai.fallbackModel,
      thinking: ai.thinking,
    });
    // The CLI refuses an empty prompt in print mode.
    const stdin = request.user.trim() ? request.user : 'Follow the instructions.';
    const timeoutMs = Math.min(ai.timeoutMs, request.timeoutMs ?? ai.timeoutMs);

    // The turn's own stop switch, so an API key named in system/init ends the child before the model answers; the
    // caller's cancellation is forwarded to it.
    const state = createTurnState();
    const read = { prices: options.prices?.() };
    const stop = new AbortController();
    // v5 (the review's security 7b): a caller's onText that throws is heard no more; the turn ends its own way.
    let hearing = request.onText !== undefined;
    const forward = () => stop.abort();
    if (request.signal?.aborted) stop.abort();
    else request.signal?.addEventListener('abort', forward, { once: true });
    let outcome;
    // v34 AIKEY: the key's value (api-key only), kept out of everything the CLI itself writes.
    const hidden = secrets();
    try {
      outcome = await runCli({
        command: cli.command,
        args: [...cli.prefixArgs, ...argv],
        env: buildChildEnv(parentEnv(), billing), // v34 AIKEY: billing
        secrets: hidden, // v34 AIKEY (review fix L3): stderr scrubbed before its cut
        cwd: workdir,
        stdin,
        timeoutMs,
        firstEventMs: ai.firstEventMs,
        signal: stop.signal,
        onLine: (line) => {
          const before = state.deltaText;
          reduceEvent(state, line, read);
          if (billedAgainst(state, billing)) stop.abort(); // v34 AIKEY: billedAgainst (AI_BILLING)
          // v5: the answer so far, for a caller that reads it as it streams (a metered call never gets that far).
          else if (hearing && state.deltaText !== before && state.deltaText !== '') {
            try {
              request.onText?.(state.deltaText);
            } catch {
              hearing = false;
              log.warn(`[ai] ${request.tag}: the streamed answer's reader failed; the reply is read whole`);
            }
          }
        },
      });
    } finally {
      request.signal?.removeEventListener('abort', forward);
      deleteSystemFile(systemFile);
    }
    // v34 AIKEY: what the CLI itself wrote never carries the key further (a log line, an error, Admin › AI's test). Each
    // text is whole here (runCli scrubbed stderr before its cut), so every shortening below comes after the scrub.
    if (hidden.length > 0) {
      outcome = { ...outcome, stderr: scrubSecrets(outcome.stderr, hidden) };
      if (state.resultText !== null) state.resultText = scrubSecrets(state.resultText, hidden);
      state.errors = state.errors.map((mark) => scrubSecrets(mark, hidden));
    }
    // end v34 AIKEY
    // Any turn that reports the seat's usage updates the reading, whether it answered or not.
    if (state.rateLimit) lastRate = readingOf(state.rateLimit, nowMs());
    noteCapacity(outcome, state);

    const verdict = interpretTurn(outcome, state, { nowMs: nowMs(), firstEventMs: ai.firstEventMs, timeoutMs, billing }); // v34 AIKEY: billing
    if (verdict.hold) setHold(verdict.hold, request.tag);
    if (state.usage) noteSideModels(state.usage.models, verdict.ok ? (verdict.model ?? request.model) : request.model);
    // v20 FIX-A (SEC-1): a turn that ended with no result event (cancelled, killed, timed out) is charged what its stream
    // showed it used: the CLI is billed for every token generated before the kill. A result event's own report stands.
    const used =
      state.usage ??
      (state.sawResult
        ? null
        : streamedUsage(state, { prices: read.prices, model: request.model, promptChars: request.system.length + stdin.length }));
    if (!verdict.ok) {
      const line = `[ai] ${request.tag} failed after ${outcome.ms} ms (${verdict.error.kind}): ${verdict.error.detail}`;
      if (verdict.error.kind === 'cancelled') log.debug(line);
      else log.warn(line);
      verdict.error.usage = used;
      throw verdict.error;
    }
    // An answer proves the seat works: lift a seat-wide hold (not one this very turn just set).
    if (!verdict.hold) holds.delete('*');
    const model = verdict.model ?? request.model;
    const tokens = used
      ? `: ${used.inputTokens} in, ${used.cacheReadTokens} cache read, ${used.cacheWriteTokens} cache write, ` +
        `${used.outputTokens} out`
      : '';
    log.debug(`[ai] ${request.tag} answered in ${outcome.ms} ms by ${model}${tokens}`);
    return { text: verdict.text, model: verdict.model, ms: outcome.ms, usage: used };
  }

  function status(force = false): Promise<CliStatus> {
    if (!force && statusCache && nowMs() - statusCache.at < HEALTH_CACHE_MS) return Promise.resolve(statusCache.value);
    probing ??= (async (): Promise<CliStatus> => {
      const checkedAt = options.now().toISOString();
      let cli: CliCommand;
      try {
        cli = resolveCli();
      } catch (error) {
        return {
          found: false,
          version: null,
          loggedIn: false,
          authMethod: null,
          subscriptionType: null,
          apiKeySource: null,
          problem:
            `The Claude CLI was not found (AI_CLI_BIN="${ai.cliBin}"): ${(error as Error).message} ` +
            'Install Claude Code and sign in, or set AI_CLI_BIN to its full path.',
          checkedAt,
        };
      }
      ensureWorkdir();
      // v34 AIKEY: the CLI is asked with the key it would run on (billing), and its answer's texts are scrubbed.
      // Review fix L3: probeCli scrubs both commands' outputs before it shortens them; scrubStatus stays as a second pass.
      const hidden = secrets();
      const probed = await probeCli({ cli, env: buildChildEnv(parentEnv(), billing), cwd: workdir, timeoutMs: HEALTH_TIMEOUT_MS, checkedAt, secrets: hidden });
      return scrubStatus(probed, hidden);
    })()
      .then((value) => {
        statusCache = { at: nowMs(), value };
        return value;
      })
      .finally(() => {
        probing = null;
      });
    return probing;
  }

  return {
    name: 'claude-cli',
    complete,
    status,
    holdFor,
    activeHolds: () => [...holds.values()].filter((hold) => hold.until > nowMs()),
    clearHolds: () => holds.clear(),
    lastRateLimit: () => lastRate,
  };
}
