import assert from 'node:assert/strict';
import test from 'node:test';
import { currentDeviceAdvertiseHosts, detectedAdvertiseHosts } from '../src/config.js';
test('automatic device address follows a network change and drops the old LAN', () => {
  assert.deepEqual(currentDeviceAdvertiseHosts({ deviceAdvertiseHost: '192.168.31.204', deviceAdvertiseHostConfigured: false }, ['172.20.10.2']), ['172.20.10.2']);
});
test('an explicitly configured device address remains authoritative', () => {
  assert.deepEqual(currentDeviceAdvertiseHosts({ deviceAdvertiseHost: 'device.example.test', deviceAdvertiseHostConfigured: true }, ['172.20.10.2']), ['device.example.test', '172.20.10.2']);
});
test('no network does not reuse a disconnected interface', () => {
  assert.deepEqual(currentDeviceAdvertiseHosts({ deviceAdvertiseHost: '192.168.31.204', deviceAdvertiseHostConfigured: false }, []), []);
});

const ipv4 = (address: string) => ({ address, family: 'IPv4', internal: false });

test('automatic detection excludes virtual adapters and prefers the default route', () => {
  const interfaces = {
    'vEthernet (Default Switch)': [ipv4('192.168.138.1')],
    '蓝牙网络连接': [ipv4('192.168.139.1')],
    'VMware Network Adapter VMnet1': [ipv4('192.168.56.1')],
    Tailscale: [ipv4('100.91.243.122')],
    WLAN: [ipv4('192.168.31.91')],
    Ethernet: [ipv4('10.0.0.20')],
  };
  assert.deepEqual(detectedAdvertiseHosts('10.0.0.20', interfaces), ['10.0.0.20', '192.168.31.91']);
  assert.deepEqual(detectedAdvertiseHosts(undefined, interfaces), ['192.168.31.91', '10.0.0.20']);
});

test('automatic detection ignores link-local, internal, and IPv6 addresses', () => {
  const interfaces = {
    WLAN: [ipv4('192.168.31.91'), { address: '169.254.10.20', family: 'IPv4', internal: false }, { address: '192.168.31.92', family: 'IPv4', internal: true }],
    Loopback: [ipv4('192.168.31.93')],
    'Wi-Fi': [{ address: 'fe80::1', family: 'IPv6', internal: false }],
  };
  assert.deepEqual(detectedAdvertiseHosts(undefined, interfaces), ['192.168.31.91']);
});

test('the default route address stays preferred when it is still advertised', () => {
  assert.deepEqual(currentDeviceAdvertiseHosts({ deviceAdvertiseHost: '192.168.31.91', deviceAdvertiseHostConfigured: false }, ['192.168.138.1', '192.168.31.91']), ['192.168.31.91', '192.168.138.1']);
});
