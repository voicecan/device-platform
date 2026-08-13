import assert from 'node:assert/strict';
import test from 'node:test';
import { Metrics } from '../src/metrics.js';

test('metrics expose cumulative HTTP latency and bounded operational gauges', () => {
  const metrics = new Metrics();
  metrics.request('GET', '/api/v1/files/:id', 200, 0.075);
  metrics.request('GET', '/api/v1/files/:id', 500, 1.5);
  metrics.connectionOpened();
  const output = metrics.render({
    operational: {
      filesPending: 3,
      deliveriesDead: 2,
      oldestPendingFileSeconds: 301,
    },
  });
  metrics.close();

  assert.match(output, /voicecan_http_requests_total\{method="GET",route="\/api\/v1\/files\/:id",status="200"\} 1/);
  assert.match(output, /voicecan_http_request_duration_seconds_bucket\{method="GET",route="\/api\/v1\/files\/:id",le="0\.1"\} 1/);
  assert.match(output, /voicecan_http_request_duration_seconds_bucket\{method="GET",route="\/api\/v1\/files\/:id",le="2\.5"\} 2/);
  assert.match(output, /voicecan_http_request_duration_seconds_count\{method="GET",route="\/api\/v1\/files\/:id"\} 2/);
  assert.match(output, /voicecan_device_connections 1/);
  assert.match(output, /voicecan_files_pending 3/);
  assert.match(output, /voicecan_event_deliveries_dead 2/);
  assert.match(output, /voicecan_oldest_pending_file_age_seconds 301/);
  assert.doesNotMatch(output, /\bNaN\b/);
});
