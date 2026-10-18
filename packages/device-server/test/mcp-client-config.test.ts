import assert from 'node:assert/strict';
import test from 'node:test';
import { clientConfiguration } from '../src/mcp-client-config.js';
test('OpenClaw uses its native mcp.servers schema and preserves dash-prefixed arguments', () => {
 const entry={command:'/node path/node',args:['/path/runner.js','stdio','--credential-ref',"/private/user's credential.token"]};
 const value=clientConfiguration('openclaw',entry);
 assert.deepEqual(JSON.parse(value.configuration).mcp.servers.voicecan_elio,{...entry,transport:'stdio',enabled:true});
 assert.ok(value.install_command?.includes("'--arg=--credential-ref'"));
 assert.ok(value.install_command?.includes("'--command' '/node path/node'"));
 assert.equal(value.verify_command,"'openclaw' 'mcp' 'doctor' 'voicecan_elio' '--probe'");
 assert.equal(clientConfiguration('claude',entry).install_command,null);
 assert.ok(clientConfiguration('codex',entry,'voicecan_elio_recordings').configuration.startsWith('[mcp_servers.voicecan_elio_recordings]'));
});
