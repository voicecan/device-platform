import { monitorEventLoopDelay } from 'node:perf_hooks';

const HTTP_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

type DurationSeries = {
  buckets: number[];
  count: number;
  sum: number;
};

export type OperationalMetrics = {
  filesPending?: number;
  filesSyncing?: number;
  filesFailed?: number;
  deliveriesPending?: number;
  deliveriesDead?: number;
  commandsQueued?: number;
  commandsInFlight?: number;
  oldestPendingFileSeconds?: number;
  oldestPendingDeliverySeconds?: number;
};

function metricNumber(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0;
}

function labels(method: string, route: string): string {
  const escape = (value: string): string => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
  return `method="${escape(method)}",route="${escape(route)}"`;
}

export class Metrics {
  #requests = new Map<string, number>();
  #durations = new Map<string, DurationSeries>();
  #activeConnections = 0;
  #eventLoop = monitorEventLoopDelay({ resolution: 20 });

  constructor() { this.#eventLoop.enable(); }
  close(): void { this.#eventLoop.disable(); }
  request(method: string, route: string, status: number, durationSeconds = 0): void {
    const requestKey = `${method}|${route}|${status}`;
    this.#requests.set(requestKey, (this.#requests.get(requestKey) ?? 0) + 1);
    const durationKey = `${method}|${route}`;
    const series = this.#durations.get(durationKey) ?? { buckets: HTTP_BUCKETS.map(() => 0), count: 0, sum: 0 };
    const duration = Math.max(0, metricNumber(durationSeconds));
    for (let index = 0; index < HTTP_BUCKETS.length; index += 1) {
      if (duration <= HTTP_BUCKETS[index]!) series.buckets[index] = (series.buckets[index] ?? 0) + 1;
    }
    series.count += 1;
    series.sum += duration;
    this.#durations.set(durationKey, series);
  }
  connectionOpened(): void { this.#activeConnections += 1; }
  connectionClosed(): void { this.#activeConnections = Math.max(0, this.#activeConnections - 1); }

  render(extra: { storageUsedRatio?: number; storageAvailableBytes?: number; operational?: OperationalMetrics } = {}): string {
    const lines = [
      '# HELP voicecan_http_requests_total HTTP requests by stable route and status.',
      '# TYPE voicecan_http_requests_total counter',
    ];
    for (const [key, value] of this.#requests) {
      const [method, route, status] = key.split('|');
      lines.push(`voicecan_http_requests_total{method="${method}",route="${route}",status="${status}"} ${value}`);
    }
    lines.push(
      '# HELP voicecan_http_request_duration_seconds HTTP response latency by stable route.',
      '# TYPE voicecan_http_request_duration_seconds histogram',
    );
    for (const [key, series] of this.#durations) {
      const [method = 'unknown', route = 'unknown'] = key.split('|');
      for (let index = 0; index < HTTP_BUCKETS.length; index += 1) {
        lines.push(`voicecan_http_request_duration_seconds_bucket{${labels(method, route)},le="${HTTP_BUCKETS[index]}"} ${series.buckets[index]}`);
      }
      lines.push(`voicecan_http_request_duration_seconds_bucket{${labels(method, route)},le="+Inf"} ${series.count}`);
      lines.push(`voicecan_http_request_duration_seconds_sum{${labels(method, route)}} ${series.sum}`);
      lines.push(`voicecan_http_request_duration_seconds_count{${labels(method, route)}} ${series.count}`);
    }
    lines.push('# TYPE voicecan_device_connections gauge', `voicecan_device_connections ${this.#activeConnections}`);
    lines.push('# TYPE voicecan_event_loop_delay_seconds gauge', `voicecan_event_loop_delay_seconds ${metricNumber(this.#eventLoop.mean / 1e9)}`);
    lines.push('# TYPE voicecan_event_loop_delay_max_seconds gauge', `voicecan_event_loop_delay_max_seconds ${metricNumber(this.#eventLoop.max / 1e9)}`);
    if (extra.storageUsedRatio !== undefined) lines.push('# TYPE voicecan_storage_used_ratio gauge', `voicecan_storage_used_ratio ${extra.storageUsedRatio}`);
    if (extra.storageAvailableBytes !== undefined) lines.push('# TYPE voicecan_storage_available_bytes gauge', `voicecan_storage_available_bytes ${extra.storageAvailableBytes}`);
    const operational = extra.operational;
    if (operational) {
      const gauges: Array<[string, number | undefined]> = [
        ['voicecan_files_pending', operational.filesPending],
        ['voicecan_files_syncing', operational.filesSyncing],
        ['voicecan_files_failed', operational.filesFailed],
        ['voicecan_event_deliveries_pending', operational.deliveriesPending],
        ['voicecan_event_deliveries_dead', operational.deliveriesDead],
        ['voicecan_commands_queued', operational.commandsQueued],
        ['voicecan_commands_in_flight', operational.commandsInFlight],
        ['voicecan_oldest_pending_file_age_seconds', operational.oldestPendingFileSeconds],
        ['voicecan_oldest_pending_delivery_age_seconds', operational.oldestPendingDeliverySeconds],
      ];
      for (const [name, value] of gauges) lines.push(`# TYPE ${name} gauge`, `${name} ${metricNumber(value)}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
