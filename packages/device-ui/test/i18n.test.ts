import assert from 'node:assert/strict';
import test from 'node:test';
import { deviceUiText } from '../src/i18n.js';

test('localized device errors preserve concrete browser details', () => {
  assert.equal(
    deviceUiText('zh-CN', 'Bluetooth notifications could not be enabled on the selected device.\nNotSupportedError: GATT operation not permitted'),
    '无法启用所选设备的蓝牙通知，请重新进入配对模式后重试。\nNotSupportedError: GATT operation not permitted',
  );
});

test('device binding copy distinguishes binding from network setup', () => {
  assert.equal(deviceUiText('zh-CN', 'Bind Voicecan device'), '绑定 Voicecan 设备');
  assert.equal(deviceUiText('zh-CN', 'Device binding grant'), '设备绑定凭证');
  assert.equal(deviceUiText('zh-CN', 'Connect & bind'), '连接并绑定');
  assert.equal(deviceUiText('zh-CN', 'Connect and bind the nearby device'), '连接并绑定附近设备');
  assert.equal(deviceUiText('zh-CN', 'Configure the device network'), '配置设备网络');
});

test('GATT discovery disconnect guidance is localized without hiding browser details', () => {
  assert.equal(
    deviceUiText('zh-CN', 'The Bluetooth connection ended while discovering the Voicecan service. Keep the device awake, in binding mode, and close other apps using it before retrying.\nNetworkError: GATT Server is disconnected.'),
    '发现 Voicecan BLE 服务时连接已断开。请让设备保持唤醒和绑定模式，关闭其他正在连接该设备的应用后重试。\nNetworkError: GATT Server is disconnected.',
  );
});

test('battery and storage telemetry labels are localized', () => {
  assert.equal(deviceUiText('zh-CN', 'Charging'), '充电中');
  assert.equal(deviceUiText('zh-CN', '{free} free of {total}', { free: '512 MB', total: '1 GB' }), '512 MB 可用，共 1 GB');
  assert.equal(deviceUiText('zh-CN', '{hours} h estimated recording time', { hours: 72 }), '预计可录音 72 小时');
});
