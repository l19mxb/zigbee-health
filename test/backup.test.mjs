import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../server/store.mjs';
import {createBackup} from '../server/backup.mjs';

test('online SQLite backup restores configuration and its credential key without overwriting an existing backup',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zigbee-backup-')),source=path.join(dir,'source','health.db'),target=path.join(dir,'backup');let store=new Store(source);
  store.set('proof',{retentionDays:90,password:store.seal('test-secret')});
  try{const result=await createBackup(source,target);assert.equal(result.integrity,'ok');assert.ok(store.get('lastBackupAt'));const restored=new Store(path.join(target,'health.db'));assert.equal(restored.get('proof').retentionDays,90);assert.equal(restored.unseal(restored.get('proof').password),'test-secret');restored.close();await assert.rejects(()=>createBackup(source,target),/already exists/);}finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
