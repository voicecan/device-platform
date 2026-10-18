/** Stop presenting a canceled poll, but let its BLE response finish before the next command. */
export async function readLiveDeviceStatus<T>(device: { getStatus(): Promise<T> }, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const status = await device.getStatus();
  signal.throwIfAborted();
  return status;
}
