export type ScheduledTask = { stop(): void };

export type ScheduledTaskReporter = (error: unknown) => void;

/**
 * Rejected background work must never escape: on Node 24 an unhandled
 * rejection terminates the process, which would take down every device
 * connection and in-flight request because one interval tick failed.
 */
export const reportScheduledFailure: ScheduledTaskReporter = (error) => {
  process.stderr.write(`scheduled task failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
};

/**
 * Runs `task` on a fixed interval without letting runs overlap: a task that
 * outlives its interval skips the pending tick instead of interleaving with
 * itself. Synchronous throws and rejected promises are reported to `onError`
 * so one failed tick cannot terminate the process or stop later ticks.
 */
export function startGuardedInterval(intervalMs: number, task: () => unknown, onError: ScheduledTaskReporter = reportScheduledFailure): ScheduledTask {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void Promise.resolve().then(task).catch(onError).finally(() => { running = false; });
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
