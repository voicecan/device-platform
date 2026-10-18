import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
const { createElement } = React;
Object.defineProperty(globalThis, 'React', { configurable: true, value: React });
import { renderToStaticMarkup } from 'react-dom/server';
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
const { DeviceConnectionWizard } = await import('../src/device-connection-wizard.js');
import { needsDeviceSetup } from '../src/device-connection-state.js';
import { translate } from '../src/i18n.js';
const t = (key: string) => translate('zh-CN', key);

test('details require a verified connection, but a later disconnect does not hide an open workspace', () => {
  assert.equal(needsDeviceSetup(true, false, '', ''), true);
  assert.equal(needsDeviceSetup(true, false, 'device-a', ''), true);
  assert.equal(needsDeviceSetup(true, true, 'device-a', ''), false);
  assert.equal(needsDeviceSetup(true, false, 'device-a', 'device-a'), false);
  assert.equal(needsDeviceSetup(true, false, 'device-b', 'device-a'), true);
  assert.equal(needsDeviceSetup(false, false, 'device-a', ''), false);
});

test('Wi-Fi errors remain on step two with fields intact; Bluetooth loss offers reconnect', () => {
  const html = renderToStaticMarkup(createElement(DeviceConnectionWizard, {
    t, name: 'Test device', networkStep: true, bluetooth: false, busy: false,
    ssid: 'Fixture network', password: 'fixture-only', encryption: 'wpa2',
    onSsid: () => {}, onPassword: () => {}, onEncryption: () => {}, onBluetooth: () => {}, onConnect: () => {},
    events: [{ stage: 'configure_wifi', state: 'failed', code: 'DEVICE_DISCONNECTED', at: 0 }],
    error: '', disconnectNotice: '', advanced: 'Technical details', devicePicker: null,
  }));
  assert.match(html, /aria-current="step"><span>2/);
  assert.match(html, /value="Fixture network"/);
  assert.match(html, /type="password"/);
  assert.match(html, /重新连接蓝牙/);
  assert.match(html, /蓝牙连接已断开/);
  assert.match(html, /<details class="device-setup-advanced">/);
});

test('server timeout identifies Wi-Fi success separately and explains reachability instead of matching SSIDs', () => {
  const html = renderToStaticMarkup(createElement(DeviceConnectionWizard, {
    t, name: 'Test device', networkStep: true, bluetooth: true, busy: false,
    ssid: 'Fixture network', password: '', encryption: 'wpa2',
    onSsid: () => {}, onPassword: () => {}, onEncryption: () => {}, onBluetooth: () => {}, onConnect: () => {},
    events: [{ stage: 'configure_wifi', state: 'done', at: 0 }, { stage: 'wifi_connected', state: 'done', at: 1 }, { stage: 'wait_server', state: 'failed', code: 'SERVER_ONLINE_TIMEOUT', at: 2 }],
    error: '', disconnectNotice: '', advanced: null, devicePicker: null,
  }));
  assert.match(html, /名称不必与电脑相同/);
  assert.match(html, /data-state="connected"><dt>设备连上 Wi-Fi<\/dt><dd>已确认连接/);
  assert.match(html, /data-state="failed"><dt>设备连上服务<\/dt><dd>未确认连接/);
  assert.match(html, /访客网络隔离/);
  assert.match(html, /未检测互联网访问/);
});

test('an observed existing network offers completion without requiring Wi-Fi credentials again', () => {
  const html = renderToStaticMarkup(createElement(DeviceConnectionWizard, {
    t, name: 'Test device', networkStep: true, bluetooth: true, busy: false, currentNetworkConnected: true,
    ssid: '', password: '', encryption: 'wpa2',
    onSsid() {}, onPassword() {}, onEncryption() {}, onBluetooth() {}, onConnect() {}, onUseCurrentNetwork() {}, onCheckNetwork() {},
    events: [{ stage: 'check_wifi', state: 'done', at: 0 }, { stage: 'wifi_connected', state: 'done', at: 1 }],
    error: '', disconnectNotice: '', advanced: null, devicePicker: null,
  }));
  assert.match(html, /设备已连上 Wi-Fi/);
  assert.match(html, /使用当前 Wi-Fi 并完成/);
  assert.match(html, /data-state="connected"/);
  assert.match(html, /<form><div class="device-setup-action"><button type="submit"/);
  assert.doesNotMatch(html.match(/<form>.*?<\/form>/s)?.[0] ?? '', /required/);
  assert.match(html, /检查设备联网/);
  assert.match(html, /更新 Wi-Fi 设置/);
});


test('setup presents the fresh battery reading before connection without blaming it for rejection', () => {
  const html = renderToStaticMarkup(createElement(DeviceConnectionWizard, {
    t: (key: string, values?: Record<string, string | number>) => translate('zh-CN', key, values),
    name: 'Test device', networkStep: true, bluetooth: true, busy: false,
    reading: { at: '2026-10-03T12:00:00Z', wifiConnected: false, batteryPercent: 10, batteryState: 'low' },
    ssid: 'Fixture network', password: '', encryption: 'wpa2',
    onSsid() {}, onPassword() {}, onEncryption() {}, onBluetooth() {}, onConnect() {},
    events: [{ stage: 'configure_wifi', state: 'failed', code: 'WIFI_CONFIGURATION_REJECTED', at: 0 }],
    error: '', disconnectNotice: '', advanced: null, devicePicker: null,
  }));
  assert.match(html, /电量 10% · 低电量/);
  assert.doesNotMatch(html, /低风险/);
  assert.match(html, /设备报告低电量/);
  assert.match(html, /失败原因尚未确定/);
  assert.match(html, /dateTime="2026-10-03T12:00:00Z"/);
  assert.doesNotMatch(html, /disabled=""[^>]*>连接并完成/);
});


test('an observed disconnected Wi-Fi is explicit before the user submits settings', () => {
  const html = renderToStaticMarkup(createElement(DeviceConnectionWizard, {
    t: (key: string, values?: Record<string, string | number>) => translate('zh-CN', key, values),
    name: 'Test device', networkStep: true, bluetooth: true, busy: false,
    reading: { at: '2026-10-03T12:00:00Z', wifiConnected: false, batteryPercent: 100, batteryState: 'normal' },
    ssid: '', password: '', encryption: 'wpa2',
    onSsid() {}, onPassword() {}, onEncryption() {}, onBluetooth() {}, onConnect() {},
    events: [], error: '', disconnectNotice: '', advanced: null, devicePicker: null,
  }));
  assert.match(html, /电量 100% · 正常/);
  assert.match(html, /data-state="disconnected"/);
  assert.doesNotMatch(html, /失败原因|低电量|AM|PM/);
});
