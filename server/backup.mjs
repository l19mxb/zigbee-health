import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {pathToFileURL} from 'node:url';

// Call explicitly; no host or application backup schedule is installed.
export async function createBackup(databaseFile,destination){
  const source=path.resolve(databaseFile),target=path.resolve(destination),keyFile=path.join(path.dirname(source),'secrets.key');
  if(!fs.existsSync(source)||!fs.existsSync(keyFile))throw Error('Database and matching secrets.key are required');
  if(fs.existsSync(target))throw Error('Backup destination already exists; refusing overwrite');
  fs.mkdirSync(target,{recursive:false,mode:0o700});
  const db=new DatabaseSync(source),output=path.join(target,'health.db');
  try{
    await backup(db,output);fs.chmodSync(output,0o600);fs.copyFileSync(keyFile,path.join(target,'secrets.key'),fs.constants.COPYFILE_EXCL);fs.chmodSync(path.join(target,'secrets.key'),0o600);
    const check=new DatabaseSync(output,{readOnly:true});const integrity=check.prepare('PRAGMA quick_check').get().quick_check;check.close();if(integrity!=='ok')throw Error('Backup integrity check failed');
    const manifest={format:1,application:'zigbee-health',createdAt:Date.now(),integrity:'ok',databaseSha256:crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex'),keySha256:crypto.createHash('sha256').update(fs.readFileSync(keyFile)).digest('hex')};
    fs.writeFileSync(path.join(target,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
    db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('lastBackupAt',JSON.stringify(manifest.createdAt));return manifest;
  }finally{db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  if(process.argv.length!==4)throw Error('Usage: node server/backup.mjs DATABASE_FILE NEW_BACKUP_DIRECTORY');
  const manifest=await createBackup(process.argv[2],process.argv[3]);console.log(JSON.stringify({status:'BACKUP_VERIFIED',createdAt:manifest.createdAt,integrity:manifest.integrity}));
}
