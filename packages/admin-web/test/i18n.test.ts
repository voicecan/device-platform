import assert from 'node:assert/strict';
import test from 'node:test';
import { translate } from '../src/i18n.js';

test('localized Admin errors preserve concrete browser details', () => {
  assert.equal(
    translate('zh-CN', 'Bluetooth notifications could not be enabled on the selected device.\nNotSupportedError: GATT operation not permitted'),
    '无法启用所选设备的蓝牙通知，请重新进入配对模式后重试。\nNotSupportedError: GATT operation not permitted',
  );
});

test('Open Platform and device binding copy is localized', () => {
  assert.equal(translate('zh-CN', 'Open platform'), '开放平台');
  assert.equal(translate('zh-CN', 'Application control plane'), '应用控制面');
  assert.equal(translate('zh-CN', 'Permissions are loaded from the server catalog and shared by REST and MCP.'), '权限从服务器目录加载，并由 REST 与 MCP 共享。');
  assert.equal(translate('zh-CN', 'Bind device'), '绑定设备');
  assert.equal(translate('zh-CN', 'Configure network and confirm binding'), '配置网络并确认绑定');
  assert.equal(translate('zh-CN', 'Event types'), '事件类型');
  assert.equal(translate('zh-CN', 'Attribute {value}', { value: 2 }), '属性 2');
  assert.equal(translate('zh-CN', 'device.capabilities_changed'), '设备能力已变更');
});

test('GATT discovery disconnect guidance is localized without hiding browser details', () => {
  assert.equal(
    translate('zh-CN', 'The Bluetooth connection ended while discovering the Voicecan service. Keep the device awake, in binding mode, and close other apps using it before retrying.\nNetworkError: GATT Server is disconnected.'),
    '发现 Voicecan BLE 服务时连接已断开。请让设备保持唤醒和绑定模式，关闭其他正在连接该设备的应用后重试。\nNetworkError: GATT Server is disconnected.',
  );
});
