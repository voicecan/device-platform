import assert from 'node:assert/strict';
import test from 'node:test';
import {recordingTask} from '../src/recording-task.js';
test('download task starts from local files without requiring an MCP connection',()=>{
 const task=recordingTask({mode:'download'});assert.ok(task.includes('不需要连接设备平台'));assert.ok(!task.includes('申请临时下载链接'));assert.ok(task.includes('无法总结'));
});
test('metadata permission never instructs an agent to fetch audio',()=>{
 const task=recordingTask({mode:'metadata',serverName:'voicecan_elio'});assert.ok(task.includes('不申请下载链接'));assert.ok(task.includes('不声称已经读取音频'));
});
test('specific recording task preserves identity and requires verified decoding and consent',()=>{
 const task=recordingTask({mode:'recordings',recordingId:'file_abc'});assert.ok(task.includes('"file_abc"'));assert.ok(task.includes('不批量下载'));assert.ok(task.includes('SHA-256'));assert.ok(task.includes('文件头'));assert.ok(task.includes('上传录音到其他服务前先征得我同意'));assert.ok(task.includes('没有可靠语音'));
});
