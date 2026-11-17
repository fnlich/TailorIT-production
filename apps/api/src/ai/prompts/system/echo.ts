import { z } from 'zod';
import { defineTextPrompt } from '../types';

// v30 ST0: moved word for word from ai/queue.ts (ECHO_SYSTEM, ECHO_USER, EchoOutput): the admin's connectivity test
// (Admin › AI › Test), one tiny JSON echo outside the queue. The queue builds its call (tag `echo`) from these.
export const ECHO_USER = 'Reply with the word pong.';
export const EchoOutput = z.object({ answer: z.string().max(200) });

export const echoPrompt = defineTextPrompt({
  area: 'system',
  name: 'echo',
  version: 1,
  description: "The admin's connectivity test: the model answers the word the message asks for.",
  text: () => 'You are a connectivity check. Put the single word the message asks for in the "answer" field.',
  output: EchoOutput,
});
