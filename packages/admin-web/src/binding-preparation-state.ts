export function selectBindingGroup(groups: readonly { id: string }[], current: string): string {
  if (current) return groups.some((group) => group.id === current) ? current : '';
  return groups.length === 1 ? groups[0]!.id : '';
}

export function webBindingStep(started: boolean, deviceStep: number, waitingForServer: boolean): number {
  if (waitingForServer) return 2;
  return started ? Math.max(0, Math.min(3, deviceStep)) : 0;
}
