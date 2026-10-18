import assert from 'node:assert/strict';
import test from 'node:test';
import { recordingListPath } from '../src/recording-query.js';
test('recording filters preserve device scope and encode opaque cursor independently',()=>{
 const path=recordingListPath({device:'dev_a',status:'synced',date:'2026-10-04',search:'SN & 2',cursor:'next+cursor='});
 const url=new URL(path,'http://localhost');
 assert.equal(url.searchParams.get('device_id'),'dev_a');
 assert.equal(url.searchParams.get('cursor'),'next+cursor=');
 assert.equal(url.searchParams.get('search'),'SN & 2');
 assert.equal(Date.parse(url.searchParams.get('to')!)-Date.parse(url.searchParams.get('from')!),86400000-1);
 assert.equal(url.searchParams.get('limit'),'25');
});
