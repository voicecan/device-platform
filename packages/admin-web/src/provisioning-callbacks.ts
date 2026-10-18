type Callbacks = {
  onStepChange(step: number): void;
  onProvisioned(): void;
  onAlreadyClaimed(deviceId: string): void;
  onError(error: unknown): void;
};

/** Long-lived connector listeners must observe the current React callbacks. */
export function forwardProvisioningEvents(current: () => Callbacks): Callbacks {
  return {
    onStepChange: (step) => current().onStepChange(step),
    onProvisioned: () => current().onProvisioned(),
    onAlreadyClaimed: (deviceId) => current().onAlreadyClaimed(deviceId),
    onError: (error) => current().onError(error),
  };
}
