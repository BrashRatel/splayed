/**
 * Runs CLI commands for the web UI, one at a time, with their output captured and their
 * confirmation questions forwarded to the browser. The UI therefore can't do anything the CLI
 * can't: every action is a CLI command with the same checks and the same prompts.
 */
import type { CliIO } from "../cli/main.ts";
import type { Progress } from "../core/progress.ts";

export interface JobLine {
  stream: "out" | "err";
  text: string;
}

export interface JobSnapshot {
  id: string;
  args: string[];
  lines: JobLine[];
  /** `recommend: "no"`: the page makes No the default button (yes skips a safety step). */
  question?: { id: string; text: string; recommend?: "no" };
  done: boolean;
  exitCode?: number;
  startedAt: string;
  /** The latest progress report while the job runs; cleared when it ends. */
  progress?: Progress & { at: string };
}

/** Commands the UI may run. `ui` itself and anything not listed are refused. */
export const UI_COMMANDS = new Set([
  "init",
  "config",
  "import",
  "descriptors",
  "forget",
  "scan",
  "status",
  "dest",
  "plan",
  "plans",
  "verify",
  "broadcast",
  "track",
  "bump",
  "donor",
]);

const FORBIDDEN_FLAGS = ["--data-dir", "--tor-socks", "--profile", "--help", "-h"];

export class JobError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/**
 * Most args one command takes: room for the plan form's coin picker, which passes
 * `--coin txid:vout` per selected coin (about 250 coins). Request bodies stay capped at 4 MiB.
 */
export const MAX_ARGS = 512;

export function validateArgs(args: unknown): string[] {
  if (!Array.isArray(args) || args.length === 0) {
    throw new JobError("args must be a non-empty list");
  }
  if (args.length > MAX_ARGS) throw new JobError(`at most ${MAX_ARGS} args`);
  for (const a of args) {
    if (typeof a !== "string" || a.length > 8192) throw new JobError("each arg must be a string");
    if (FORBIDDEN_FLAGS.some((f) => a === f || a.startsWith(`${f}=`))) {
      throw new JobError(`${a} can't be set from the UI`);
    }
  }
  if (!UI_COMMANDS.has(args[0] as string)) {
    throw new JobError(`Command "${args[0]}" isn't available in the UI`);
  }
  return args as string[];
}

interface Job extends JobSnapshot {
  answer?: (yes: boolean) => void;
}

export class JobRunner {
  #current?: Job;
  #history: Job[] = [];

  constructor(
    private readonly run: (argv: string[], io: CliIO) => Promise<number>,
    private readonly baseIO: Omit<CliIO, "out" | "err" | "confirm">,
    private readonly dataDir: string,
  ) {}

  get busy(): boolean {
    return !!this.#current && !this.#current.done;
  }

  start(rawArgs: unknown): JobSnapshot {
    const args = validateArgs(rawArgs);
    if (this.busy) throw new JobError("Another command is still running", 409);
    const job: Job = {
      id: crypto.randomUUID(),
      args,
      lines: [],
      done: false,
      startedAt: new Date().toISOString(),
    };
    this.#current = job;
    this.#history = [job, ...this.#history].slice(0, 20);
    const io: CliIO = {
      ...this.baseIO,
      out: (text) => job.lines.push({ stream: "out", text }),
      err: (text) => job.lines.push({ stream: "err", text }),
      progress: (p) => {
        if (!job.done) job.progress = { ...p, at: new Date().toISOString() };
      },
      confirm: (text, opts) =>
        new Promise<boolean>((resolve) => {
          const qid = crypto.randomUUID();
          job.question = {
            id: qid,
            text,
            ...(opts?.recommend ? { recommend: opts.recommend } : {}),
          };
          job.answer = (yes) => {
            job.question = undefined;
            job.answer = undefined;
            job.lines.push({ stream: "out", text: `> ${text} ${yes ? "yes" : "no"}` });
            resolve(yes);
          };
        }),
    };
    this.run(["--data-dir", this.dataDir, ...args], io)
      .then((code) => (job.exitCode = code))
      .catch((error) => {
        job.lines.push({ stream: "err", text: `Unexpected error: ${(error as Error).message}` });
        job.exitCode = 1;
      })
      .finally(() => {
        job.done = true;
        job.question = undefined;
        job.progress = undefined;
      });
    return this.snapshot(job);
  }

  answer(jobId: string, questionId: string, yes: boolean): void {
    const job = this.#find(jobId);
    if (!job.question || job.question.id !== questionId || !job.answer) {
      throw new JobError("That question is no longer pending", 409);
    }
    job.answer(yes);
  }

  get(jobId: string, after = 0): JobSnapshot {
    const job = this.#find(jobId);
    return { ...this.snapshot(job), lines: job.lines.slice(after) };
  }

  current(): JobSnapshot | null {
    return this.#current ? this.snapshot(this.#current) : null;
  }

  #find(id: string): Job {
    const job = this.#history.find((j) => j.id === id);
    if (!job) throw new JobError("No such job", 404);
    return job;
  }

  private snapshot(job: Job): JobSnapshot {
    return {
      id: job.id,
      args: job.args,
      lines: job.lines,
      question: job.question,
      done: job.done,
      exitCode: job.exitCode,
      startedAt: job.startedAt,
      progress: job.progress,
    };
  }
}
