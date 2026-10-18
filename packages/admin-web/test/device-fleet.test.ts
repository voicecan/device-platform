import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
Object.defineProperty(globalThis, 'React', { value: React, configurable: true });
Object.defineProperty(globalThis, 'sessionStorage', { value: { getItem: () => null }, configurable: true });
const { DeviceFleetView, deviceListPath } = await import('../src/device-fleet.js');
import { translate } from '../src/i18n.js';
const t = (key: string, values?: Record<string, string | number>) => translate('zh-CN', key, values);
const noop = () => {};

test('server query encodes search, status, group and current-page cursor', () => {
  const path = deviceListPath({ search: 'Room & 2', online: 'false', group: 'grp_a', cursor: 'safe=cursor' });
  const url = new URL(path, 'http://localhost');
  assert.equal(url.pathname, '/admin/devices'); assert.equal(url.searchParams.get('limit'), '25');
  assert.equal(url.searchParams.get('search'), 'Room & 2'); assert.equal(url.searchParams.get('online'), 'false');
  assert.equal(url.searchParams.get('group_id'), 'grp_a'); assert.equal(url.searchParams.get('cursor'), 'safe=cursor');
});

test('fleet displays independent device rows and true server statuses, not a selected control panel', () => {
  const html = renderToStaticMarkup(React.createElement(DeviceFleetView, { t, search: '', online: '', group: '', groups: [], page: 0, loading: false, error: '', onSearch: noop, onOnline: noop, onGroup: noop, onSelect: noop, onRefresh: noop, onPrevious: noop, onNext: noop, data: { items: [{ id: 'dev_a', sn: 'FLEET-A', display_name: '会议室', online: true, group_name: '开发组' }, { id: 'dev_b', sn: 'FLEET-B', display_name: '外出录音', online: false }], total_count: 10000, summary: { online: 8000, offline: 2000 }, next_cursor: 'next' } }));
  assert.match(html, /会议室/); assert.match(html, /外出录音/); assert.match(html, /FLEET-A/); assert.match(html, /FLEET-B/);
  assert.match(html, /服务器在线/); assert.match(html, /服务器离线/); assert.match(html, /10,000/);
  assert.doesNotMatch(html, /Wi-Fi 密码|设备控制中心/);
});
