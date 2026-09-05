/**
 * Handoff brief worker.
 *
 * When a task is transferred, this generates the context brief the receiver
 * reads first. The pipeline is:
 *
 *   TaskTransferred -> Bull queue -> gather context -> Claude -> validate ->
 *   persist -> notify the realtime gateway
 *
 * Design rules:
 *
 *   * A brief is always produced. If the model is slow, unreachable, or returns
 *     something unusable, {@link buildFallbackBrief} derives one from the event
 *     stream. A receiver never lands on an empty page.
 *   * Citations are verified. The model is asked to cite the events it used, and
 *     any id that is not actually in the task's stream is dropped before the row
 *     is written — an invented citation is worse than none.
 *   * Retries live in exactly one place. Bull owns the retry policy; the SDK's
 *     own retries are disabled so the two do not multiply into 9 API calls.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import Queue, { type Job, type JobOptions } from 'bull';
import { z } from 'zod';

import {
  EventType,
  type HandoffBriefContent,
  type ISODateTime,
  type TaskEvent,
  type UUID,
} from '@handoff/domain';

// =============================================================================
// Configuration
// =============================================================================

/**
 * Default model.
 *
 * `claude-opus-5` is the current default model. `ANTHROPIC_MODEL` overrides it;
 * for this workload `claude-sonnet-5` is a reasonable cost choice ($2/$10 per
 * MTok vs $5/$25) since a handoff brief is short-form summarization over a
 * bounded context.
 *
 * Note: `claude-sonnet-4-6` — the value in the committed `.env.example` — is a
 * real model but previous-generation, and strictly more expensive than
 * `claude-sonnet-5` ($3/$15). There is no reason to pick it for new work.
 */
const DEFAULT_MODEL = 'claude-opus-5';

/**
 * Reasoning effort.
 *
 * Low by default: this is short-form summarization under a hard 30s deadline,
 * and the guidance is that summarization does not repay high effort. Raise it
 * with `ANTHROPIC_EFFORT` if brief quality proves insufficient — but watch the
 * timeout rate, since a timeout costs a full request and yields the fallback.
 */
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const DEFAULT_EFFORT: Effort = 'low';

export interface WorkerConfig {
  model: string;
  effort: Effort;
  /** Hard deadline for the model call, ms. Past this the fallback is used. */
  requestTimeoutMs: number;
  maxTokens: number;
  /** Bull attempts, including the first. */
  attempts: number;
  /** Base delay for exponential backoff, ms. */
  backoffDelayMs: number;
  /** Most recent events handed to the model. */
  maxEvents: number;
  maxComments: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const effort = env.ANTHROPIC_EFFORT as Effort | undefined;
  return {
    model: env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL,
    effort:
      effort && ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)
        ? effort
        : DEFAULT_EFFORT,
    requestTimeoutMs: positiveInt(env.BRIEF_TIMEOUT_MS, 30_000),
    maxTokens: positiveInt(env.BRIEF_MAX_TOKENS, 8_000),
    attempts: positiveInt(env.BRIEF_ATTEMPTS, 3),
    backoffDelayMs: positiveInt(env.BRIEF_BACKOFF_MS, 2_000),
    maxEvents: positiveInt(env.BRIEF_MAX_EVENTS, 60),
    maxComments: positiveInt(env.BRIEF_MAX_COMMENTS, 40),
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// =============================================================================
// Errors
// =============================================================================

export enum BriefErrorCode {
  CONTEXT_UNAVAILABLE = 'CONTEXT_UNAVAILABLE',
  GENERATION_FAILED = 'GENERATION_FAILED',
  GENERATION_TIMEOUT = 'GENERATION_TIMEOUT',
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  PERSIST_FAILED = 'PERSIST_FAILED',
}

export abstract class BriefError extends Error {
  abstract readonly code: BriefErrorCode;

  // Public rather than protected: the class is abstract, so it cannot be
  // instantiated directly anyway, and subclasses that need no extra fields
  // should not have to redeclare a constructor just to widen visibility.
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The handoff or its task could not be loaded; nothing can be generated. */
export class ContextUnavailableError extends BriefError {
  readonly code = BriefErrorCode.CONTEXT_UNAVAILABLE;
}

/** The model call failed. Recoverable: the fallback covers it. */
export class GenerationFailedError extends BriefError {
  readonly code = BriefErrorCode.GENERATION_FAILED;
}

/** The model did not answer within the deadline. */
export class GenerationTimeoutError extends BriefError {
  readonly code = BriefErrorCode.GENERATION_TIMEOUT;

  constructor(timeoutMs: number, cause?: unknown) {
    super(`Brief generation exceeded ${timeoutMs}ms.`, cause);
  }
}

/** The model answered, but not in a shape we can store. */
export class BriefValidationError extends BriefError {
  readonly code = BriefErrorCode.VALIDATION_FAILED;

  constructor(
    message: string,
    readonly issues?: unknown,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

/** The brief could not be written. This one is genuinely fatal. */
export class BriefPersistError extends BriefError {
  readonly code = BriefErrorCode.PERSIST_FAILED;
}

// =============================================================================
// Brief schema
// =============================================================================

/**
 * The contract the model must satisfy.
 *
 * Passed to the API as a structured-output format, so the response is
 * constrained at generation time rather than merely checked afterwards. The
 * bounds are part of the contract: they stop a model from padding a brief into
 * something nobody reads.
 */
export const briefSchema = z.object({
  objective: z
    .string()
    .min(1)
    .max(500)
    .describe("The task's current goal, in one sentence, from the receiver's point of view."),
  whatHappened: z
    .string()
    .min(1)
    .max(2000)
    .describe('What has happened so far: progress, changes, and why the task is being handed over.'),
  decisions: z
    .array(z.string().min(1).max(400))
    .max(10)
    .describe('Decisions already made that the receiver should not relitigate. Empty if none.'),
  blockers: z
    .array(z.string().min(1).max(400))
    .max(10)
    .describe('Unresolved blockers and risks. Empty if nothing is blocking.'),
  remainingWork: z
    .string()
    .min(1)
    .max(1500)
    .describe('What still needs to happen for this task to be complete.'),
  suggestedNextAction: z
    .string()
    .min(1)
    .max(400)
    .describe('The single first thing the receiver should do.'),
  sourceEventIds: z
    .array(z.string())
    .max(100)
    .describe('Ids of the events this brief draws on. Use only ids given in the context.'),
});

export type GeneratedBrief = z.infer<typeof briefSchema>;

// =============================================================================
// Collaborators
// =============================================================================

/** A comment as the generator needs it. */
export interface CommentInput {
  id: UUID;
  authorId: UUID | null;
  body: string;
  createdAt: ISODateTime;
}

/** Everything the generator reads about one handoff. */
export interface BriefContext {
  handoffId: UUID;
  taskId: UUID;
  taskTitle: string;
  taskStatus: string;
  fromUserId: UUID | null;
  toUserId: UUID;
  transferReason: string | null;
  events: TaskEvent[];
  comments: CommentInput[];
  /** Decisions already extracted by the caller, if any. */
  decisions: string[];
}

/** Loads the context for a handoff. Backed by SQL in production. */
export interface ContextLoader {
  load(handoffId: UUID): Promise<BriefContext>;
}

/** Persists a finished brief. */
export interface BriefStore {
  save(input: {
    handoffId: UUID;
    content: HandoffBriefContent;
    sourceEventIds: UUID[];
    model: string;
  }): Promise<{ id: UUID }>;
}

/** Announces outcomes to the rest of the system. */
export interface BriefNotifier {
  briefReady(input: {
    handoffId: UUID;
    taskId: UUID;
    toUserId: UUID;
    briefId: UUID;
    /** False when the deterministic fallback was stored. */
    aiGenerated: boolean;
  }): Promise<void>;

  briefFailed(input: {
    handoffId: UUID;
    taskId: UUID;
    toUserId: UUID;
    reason: string;
  }): Promise<void>;
}

export interface Logger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, err?: unknown): void;
}

export const consoleLogger: Logger = {
  info: (m, meta) => console.log(`[brief] ${m}`, meta ?? ''),
  warn: (m, meta) => console.warn(`[brief] ${m}`, meta ?? ''),
  // Sentry (or equivalent) belongs here; console is the interim sink.
  error: (m, err) => console.error(`[brief] ${m}`, err ?? ''),
};

// =============================================================================
// Prompting
// =============================================================================

const SYSTEM_PROMPT = `You are a task handoff assistant. Summarize task history for the new owner.

You are writing for someone who is picking up work they have never seen. Be concrete and specific: name the actual blocker, the actual decision, the actual next step. Prefer the words used in the events and comments over generic phrasing.

Rules:
- Ground every statement in the supplied events and comments. Do not invent status, people, dates, or decisions.
- If something is genuinely unknown, say so plainly rather than guessing.
- In sourceEventIds, cite only event ids that appear in the context you were given.
- Leave decisions or blockers empty rather than padding them with restatements of the objective.`;

/** Render the context as the user turn. */
export function buildUserPrompt(ctx: BriefContext, config: WorkerConfig): string {
  const events = ctx.events
    .slice(-config.maxEvents)
    .map((e) => {
      const payload = JSON.stringify(e.payload);
      return `- id=${e.id} seq=${e.sequence} type=${e.type} at=${e.createdAt} actor=${
        e.actorId ?? 'unknown'
      } payload=${payload}`;
    })
    .join('\n');

  const comments = ctx.comments
    .slice(-config.maxComments)
    .map((c) => `- ${c.createdAt} by ${c.authorId ?? 'unknown'}: ${c.body}`)
    .join('\n');

  return [
    '<task>',
    `title: ${ctx.taskTitle}`,
    `status: ${ctx.taskStatus}`,
    `id: ${ctx.taskId}`,
    '</task>',
    '',
    '<handoff>',
    `from: ${ctx.fromUserId ?? 'unowned'}`,
    `to: ${ctx.toUserId}`,
    `reason: ${ctx.transferReason ?? '(none given)'}`,
    '</handoff>',
    '',
    '<events>',
    events || '(no events)',
    '</events>',
    '',
    '<comments>',
    comments || '(no comments)',
    '</comments>',
    ...(ctx.decisions.length
      ? ['', '<decisions_already_identified>', ...ctx.decisions.map((d) => `- ${d}`), '</decisions_already_identified>']
      : []),
    '',
    'Write the handoff brief for the new owner.',
  ].join('\n');
}

// =============================================================================
// Fallback
// =============================================================================

/**
 * Deterministic brief built from the event stream.
 *
 * Used when the model is unavailable, too slow, or returns something unusable.
 * It is written to be genuinely useful rather than a placeholder: the stream
 * already records who did what, why the task was blocked, and where it stands.
 */
export function buildFallbackBrief(ctx: BriefContext): GeneratedBrief {
  const ordered = [...ctx.events].sort((a, b) => a.sequence - b.sequence);

  // A block only counts as a live blocker if it was never resolved.
  const blockers: string[] = [];
  for (const e of ordered) {
    if (e.type === EventType.TaskBlocked) blockers.push(e.payload.reason);
    if (e.type === EventType.TaskUnblocked) blockers.pop();
  }

  const decisions = [
    ...ctx.decisions,
    ...ordered.flatMap((e) => {
      if (e.type === EventType.TaskTransferred && e.payload.reason) {
        return [`Transferred due to: ${e.payload.reason}`];
      }
      if (e.type === EventType.TaskReopened) return [`Reopened: ${e.payload.reason}`];
      if (e.type === EventType.TaskUnblocked) return [`Unblocked: ${e.payload.resolution}`];
      return [];
    }),
  ];
  if (ctx.transferReason && decisions.length === 0) {
    decisions.push(`Transferred due to: ${ctx.transferReason}`);
  }

  const from = ctx.fromUserId ?? 'an unassigned queue';

  return {
    objective: ctx.taskTitle,
    whatHappened:
      `Transferred from ${from} to ${ctx.toUserId}. ` +
      `${ordered.length} event${ordered.length === 1 ? '' : 's'} recorded; ` +
      `the task is currently ${ctx.taskStatus}.`,
    decisions,
    blockers,
    remainingWork: blockers.length
      ? 'Clear the outstanding blockers, then continue with the current objectives.'
      : 'Continue with current objectives.',
    suggestedNextAction: 'Review task history for context.',
    // Deliberately empty: nothing here is a citation of a model's reading.
    sourceEventIds: [],
  };
}

// =============================================================================
// BriefGenerator
// =============================================================================

export interface GenerateResult {
  brief: GeneratedBrief;
  /** False when the deterministic fallback was used. */
  aiGenerated: boolean;
  model: string;
  /** Why the fallback was used, when it was. */
  fallbackReason?: string;
}

/**
 * Produces a handoff brief for one handoff.
 *
 * Separated from the queue so it can be driven directly by the manual
 * regeneration endpoint, and tested without Redis.
 */
export class BriefGenerator {
  private readonly config: WorkerConfig;

  constructor(
    private readonly deps: {
      anthropic: Pick<Anthropic, 'messages'>;
      loader: ContextLoader;
      store: BriefStore;
      notifier: BriefNotifier;
      logger?: Logger;
    },
    config: Partial<WorkerConfig> = {},
  ) {
    this.config = { ...loadConfig(), ...config };
  }

  private get log(): Logger {
    return this.deps.logger ?? consoleLogger;
  }

  /**
   * Generate, validate, persist, and announce a brief.
   *
   * @throws {ContextUnavailableError} when the handoff cannot be loaded — the
   *   only failure that is not covered by the fallback.
   * @throws {BriefPersistError} when the row cannot be written.
   */
  async run(handoffId: UUID): Promise<{ briefId: UUID; result: GenerateResult }> {
    const ctx = await this.loadContext(handoffId);
    const result = await this.generate(ctx);

    // Citations are checked against the stream, not trusted.
    const sourceEventIds = this.verifyCitations(result.brief.sourceEventIds, ctx);

    const content: HandoffBriefContent = {
      objective: result.brief.objective,
      whatHappened: result.brief.whatHappened,
      decisions: result.brief.decisions,
      blockers: result.brief.blockers,
      remainingWork: result.brief.remainingWork,
      suggestedNextAction: result.brief.suggestedNextAction,
    };

    let briefId: UUID;
    try {
      ({ id: briefId } = await this.deps.store.save({
        handoffId,
        content,
        sourceEventIds,
        // Record which model actually produced it; 'fallback' is not a model,
        // and conflating them would make the UI claim AI provenance it lacks.
        model: result.aiGenerated ? result.model : 'fallback',
      }));
    } catch (err) {
      this.log.error(`persisting brief for handoff ${handoffId} failed`, err);
      throw new BriefPersistError(`Could not store the brief for handoff ${handoffId}.`, err);
    }

    await this.safeNotify(() =>
      this.deps.notifier.briefReady({
        handoffId,
        taskId: ctx.taskId,
        toUserId: ctx.toUserId,
        briefId,
        aiGenerated: result.aiGenerated,
      }),
    );

    this.log.info(`brief stored for handoff ${handoffId}`, {
      briefId,
      aiGenerated: result.aiGenerated,
      citations: sourceEventIds.length,
      ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
    });

    return { briefId, result };
  }

  private async loadContext(handoffId: UUID): Promise<BriefContext> {
    try {
      return await this.deps.loader.load(handoffId);
    } catch (err) {
      if (err instanceof BriefError) throw err;
      throw new ContextUnavailableError(
        `Could not load context for handoff ${handoffId}.`,
        err,
      );
    }
  }

  /**
   * Ask the model, falling back to the deterministic brief on any failure.
   *
   * Never throws: a brief is always produced.
   */
  async generate(ctx: BriefContext): Promise<GenerateResult> {
    const fallback = (reason: string): GenerateResult => ({
      brief: buildFallbackBrief(ctx),
      aiGenerated: false,
      model: this.config.model,
      fallbackReason: reason,
    });

    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      this.log.warn('no Anthropic credential configured; using the derived brief');
      return fallback('no API credential configured');
    }

    try {
      const brief = await this.callModel(ctx);
      return { brief, aiGenerated: true, model: this.config.model };
    } catch (err) {
      if (err instanceof GenerationTimeoutError) {
        this.log.warn(`brief generation timed out for handoff ${ctx.handoffId}`);
        return fallback(`timed out after ${this.config.requestTimeoutMs}ms`);
      }
      if (err instanceof BriefValidationError) {
        this.log.warn(`model returned an unusable brief for handoff ${ctx.handoffId}`, err.issues);
        return fallback(err.message);
      }
      this.log.error(`brief generation failed for handoff ${ctx.handoffId}`, err);
      return fallback(err instanceof Error ? err.message : 'unknown error');
    }
  }

  /** One structured-output call, bounded by the configured deadline. */
  private async callModel(ctx: BriefContext): Promise<GeneratedBrief> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    try {
      const response = await this.deps.anthropic.messages.parse(
        {
          model: this.config.model,
          max_tokens: this.config.maxTokens,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: buildUserPrompt(ctx, this.config) }],
          output_config: {
            effort: this.config.effort,
            // Constrains generation to the schema rather than checking after.
            format: zodOutputFormat(briefSchema),
          },
        },
        { signal: controller.signal, timeout: this.config.requestTimeoutMs },
      );

      // A safety decline is not an exception; it arrives as a 200.
      if (response.stop_reason === 'refusal') {
        throw new GenerationFailedError(
          `Model declined to produce the brief (${response.stop_details?.category ?? 'unspecified'}).`,
        );
      }
      if (response.stop_reason === 'max_tokens') {
        throw new BriefValidationError('Model output was truncated at max_tokens.');
      }

      const parsed = response.parsed_output;
      if (!parsed) {
        throw new BriefValidationError('Model response did not parse against the brief schema.');
      }
      return parsed;
    } catch (err) {
      if (err instanceof BriefError) throw err;
      if (controller.signal.aborted || isAbortError(err)) {
        throw new GenerationTimeoutError(this.config.requestTimeoutMs, err);
      }
      throw wrapAnthropicError(err);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Keep only citations that name a real event on this task.
   *
   * An id the model invented would send a reader looking for something that
   * does not exist, so unknown ids are dropped and logged rather than stored.
   */
  private verifyCitations(cited: string[], ctx: BriefContext): UUID[] {
    const known = new Set(ctx.events.map((e) => e.id));
    const valid: UUID[] = [];
    const invalid: string[] = [];

    for (const id of new Set(cited)) {
      if (known.has(id)) valid.push(id);
      else invalid.push(id);
    }

    if (invalid.length > 0) {
      this.log.warn(`dropped ${invalid.length} unverifiable citation(s)`, {
        handoffId: ctx.handoffId,
        invalid: invalid.slice(0, 10),
      });
    }
    return valid;
  }

  /** A failed notification must not fail the job; the brief is already stored. */
  private async safeNotify(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.log.error('notification failed (brief was stored)', err);
    }
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' ||
      err.name === 'APIUserAbortError' ||
      err.name === 'APIConnectionTimeoutError')
  );
}

/** Map SDK errors onto this worker's types, most specific first. */
function wrapAnthropicError(err: unknown): BriefError {
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new GenerationTimeoutError(0, err);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new GenerationFailedError('Rate limited by the Anthropic API.', err);
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return new GenerationFailedError('Anthropic API credential rejected.', err);
  }
  if (err instanceof Anthropic.APIError) {
    return new GenerationFailedError(`Anthropic API error ${err.status}: ${err.message}`, err);
  }
  return new GenerationFailedError(
    err instanceof Error ? err.message : 'Unknown generation failure.',
    err,
  );
}

// =============================================================================
// Queue
// =============================================================================

export const BRIEF_QUEUE_NAME = 'handoff-brief';

export interface BriefJobData {
  handoffId: UUID;
  taskId: UUID;
  toUserId: UUID;
  /** Set when a user asked for a regeneration rather than a transfer. */
  requestedByUserId?: UUID;
}

/**
 * Job options.
 *
 * `attempts: 3` with exponential backoff, per the spec. The SDK's own retries
 * are switched off in {@link createAnthropicClient} so these are the only
 * retries — otherwise three Bull attempts times three SDK retries would be
 * nine API calls for one brief.
 */
export function jobOptions(config: WorkerConfig): JobOptions {
  return {
    attempts: config.attempts,
    backoff: { type: 'exponential', delay: config.backoffDelayMs },
    removeOnComplete: 100,
    removeOnFail: 500,
    // One brief per handoff: a duplicate TaskTransferred replay is a no-op
    // rather than a second row racing the first.
    jobId: undefined,
  };
}

/** Producer-side queue, for the API to enqueue on TaskTransferred. */
export function createQueue(redisUrl = process.env.REDIS_URL): Queue.Queue<BriefJobData> {
  if (!redisUrl) {
    throw new Error('REDIS_URL must be set to use the handoff-brief queue.');
  }
  return new Queue<BriefJobData>(BRIEF_QUEUE_NAME, redisUrl);
}

/**
 * Enqueue a brief job.
 *
 * `jobId` is the handoff id, so Bull deduplicates: replaying the same
 * TaskTransferred event will not generate a second brief.
 */
export async function enqueueBrief(
  queue: Queue.Queue<BriefJobData>,
  data: BriefJobData,
  config: WorkerConfig = loadConfig(),
): Promise<void> {
  await queue.add(data, { ...jobOptions(config), jobId: `handoff:${data.handoffId}` });
}

/**
 * Start the consumer.
 *
 * Bull retries a throwing handler. Only genuinely unrecoverable failures throw:
 * a model problem yields the fallback brief and the job succeeds, because
 * retrying a slow or refusing model three times just delays a brief the
 * receiver could already be reading.
 */
export function startWorker(deps: {
  generator: BriefGenerator;
  notifier: BriefNotifier;
  queue?: Queue.Queue<BriefJobData>;
  logger?: Logger;
  config?: WorkerConfig;
  concurrency?: number;
}): Queue.Queue<BriefJobData> {
  const log = deps.logger ?? consoleLogger;
  const config = deps.config ?? loadConfig();
  const queue = deps.queue ?? createQueue();

  queue.process(deps.concurrency ?? 2, async (job: Job<BriefJobData>) => {
    const { handoffId } = job.data;
    log.info(`processing handoff ${handoffId}`, { attempt: job.attemptsMade + 1 });
    const { briefId, result } = await deps.generator.run(handoffId);
    return { briefId, aiGenerated: result.aiGenerated };
  });

  queue.on('failed', (job: Job<BriefJobData>, err: Error) => {
    const isFinal = job.attemptsMade >= (job.opts.attempts ?? config.attempts);
    log.error(
      `job for handoff ${job.data.handoffId} failed ` +
        `(attempt ${job.attemptsMade}${isFinal ? ', final' : ''})`,
      err,
    );

    if (!isFinal) return;
    // Out of retries: tell the UI so it can offer "view events instead"
    // rather than spinning on a brief that will never arrive.
    void deps.notifier
      .briefFailed({
        handoffId: job.data.handoffId,
        taskId: job.data.taskId,
        toUserId: job.data.toUserId,
        reason: err.message,
      })
      .catch((notifyErr: unknown) => log.error('failure notification failed', notifyErr));
  });

  queue.on('error', (err: Error) => log.error('queue error', err));

  log.info(`worker listening on "${BRIEF_QUEUE_NAME}"`, {
    model: config.model,
    effort: config.effort,
    timeoutMs: config.requestTimeoutMs,
  });
  return queue;
}

// =============================================================================
// Client
// =============================================================================

/**
 * Anthropic client for this worker.
 *
 * `maxRetries: 0` is deliberate — Bull owns the retry policy (see
 * {@link jobOptions}). Leaving the SDK default of 2 in place would multiply
 * with Bull's attempts.
 */
export function createAnthropicClient(): Anthropic {
  return new Anthropic({
    maxRetries: 0,
    // Per-request timeout is set on the call itself; this is a backstop.
    timeout: positiveInt(process.env.BRIEF_TIMEOUT_MS, 30_000),
  });
}
