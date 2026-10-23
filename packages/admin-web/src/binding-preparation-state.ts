export const bindingIntentPollMs = 2_000;
export const bindingIntentMaxPollMs = 60_000;

export function selectBindingGroup(groups: readonly { id: string }[], current: string): string {
  if (current) return groups.some((group) => group.id === current) ? current : '';
  return groups.length === 1 ? groups[0]!.id : '';
}

export function webBindingStep(started: boolean, deviceStep: number, waitingForServer: boolean): number {
  if (waitingForServer) return 2;
  return started ? Math.max(0, Math.min(3, deviceStep)) : 0;
}

/**
 * A transient failure must not turn into a permanent error banner every poll.
 * Back off up to one minute and reset as soon as a poll succeeds.
 */
export function nextBindingPollDelay(previousMs: number, failed: boolean): number {
  if (!failed) return bindingIntentPollMs;
  return Math.min(bindingIntentMaxPollMs, Math.max(bindingIntentPollMs, previousMs * 2));
}
