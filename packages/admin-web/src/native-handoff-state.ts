export type NativeHandoff = {
  id: string;
  status: string;
  client_fingerprint: string | null;
  lease_expires_at: string | null;
  expires_at: string;
};

export type Snapshot = {
  execution_epoch: number;
  active_handoff_id: string | null;
  handoffs: NativeHandoff[];
};

export function hasActiveNativeExecutor(snapshot: Snapshot, now = Date.now()): boolean {
  return snapshot.handoffs.some(item => item.id === snapshot.active_handoff_id && item.status === 'approved' && Date.parse(item.lease_expires_at ?? '') > now);
}

export function visibleNativeHandoffs(snapshot: Snapshot, now: number): NativeHandoff[] {
  return snapshot.handoffs.filter(item => item.status !== 'cancelled' && item.client_fingerprint && Date.parse(item.expires_at) > now);
}
