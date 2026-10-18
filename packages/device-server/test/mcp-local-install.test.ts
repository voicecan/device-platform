import assert from 'node:assert/strict';
import test from 'node:test';
import { installCodexMcp } from '../src/mcp-local-install.js';
const entry = { command: '/node', args: ['/runner', '--credential-ref', '/private/file'] };
test('installation preserves an existing different MCP entry', async () => {
  const calls: string[][] = [];
  await assert.rejects(installCodexMcp(entry, async (args) => { calls.push(args); return JSON.stringify([{ name: 'voicecan_elio', transport: { type: 'stdio', command: '/different', args: [] } }]); }), { code: 'MCP_NAME_CONFLICT' });
  assert.equal(calls.length, 1);
});
test('matching enabled configuration is reused without overwriting', async () => {
  const calls: string[][] = [];
  const result = await installCodexMcp(entry, async (args) => { calls.push(args); return JSON.stringify([{ name: 'voicecan_elio', enabled: true, transport: { type: 'stdio', ...entry } }]); });
  assert.equal(result, 'already_installed'); assert.equal(calls.length, 1);
});
test('fresh install passes argv without a shell and verifies the saved entry', async () => {
  const calls: string[][] = [];
  const result = await installCodexMcp(entry, async (args) => { calls.push(args); return args[1] === 'list' ? '[]' : args[1] === 'get' ? JSON.stringify({ name: 'voicecan_elio', enabled: true, transport: { type: 'stdio', ...entry } }) : ''; });
  assert.equal(result, 'installed'); assert.deepEqual(calls[1], ['mcp', 'add', 'voicecan_elio', '--', entry.command, ...entry.args]);
});

test('connection check requires a real authorized recording query, not an advertised tool list', async (t) => {
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {verifyLocalMcp}=await import('../src/mcp-local-install.js');
  const dir=await mkdtemp(join(tmpdir(),'voicecan-mcp-probe-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const script=join(dir,'fake.mjs');
  await writeFile(script,`import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(!q.id)return;let result;
if(q.id===1)result={serverInfo:{name:'@voicecan/device-mcp'}};
if(q.id===2)result={tools:[{name:'voicecan.recordings.search'}]};
if(q.id===3)result=process.argv[2]==='denied'?{isError:true,content:[{type:'text',text:'access denied'}]}:{content:[{type:'text',text:JSON.stringify({items:[]})}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');});`);
  const entry={command:process.execPath,args:[script,'allowed']};
  assert.equal(await verifyLocalMcp(entry),1);
  await assert.rejects(verifyLocalMcp({...entry,args:[script,'denied']}),{code:'MCP_HEALTH_CHECK_FAILED'});
});
