'use strict';
// Copiato nel repository pubblico dei download come make-release.cjs. Non ha accesso a chiavi private.
// Verifica la firma, costruisce lo ZIP Windows completo (gioco + motore Electron ufficiale) e pubblica la release.
// Ripreso da Montaperti (tools/public-client-release.cjs).
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const repository='rigorage/montaperti-shooter',root=process.cwd(),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const quote=s=>"'"+s.replaceAll("'","''")+"'";
function ps(code){const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; "+code],{stdio:'inherit',windowsHide:true});if(r.status!==0)throw Error('Archivio Windows non riuscito');}
async function build(rootDir=root){
 const envelope=JSON.parse(fs.readFileSync(path.join(rootDir,'update.json'))),bytes=Buffer.from(envelope.payload,'base64'),key=JSON.parse(fs.readFileSync(path.join(rootDir,'update-public-key.json'))).pem;
 if(!crypto.verify('sha256',bytes,key,Buffer.from(envelope.signature,'base64')))throw Error('Firma release non valida');
 const info=JSON.parse(bytes),zip=path.join(rootDir,'Shooter-app.zip');if(sha(fs.readFileSync(zip))!==info.appSha256||fs.statSync(zip).size!==info.appSize)throw Error('Pacchetto danneggiato');
 const name=`Montaperti-Shooter-Windows-${info.gameVersion}`,out=path.join(rootDir,'dist',name);if(fs.existsSync(out))throw Error('Destinazione esistente');fs.mkdirSync(path.dirname(out),{recursive:true});
 ps(`[System.IO.Compression.ZipFile]::ExtractToDirectory(${quote(zip)},${quote(out)})`);
 for(const [file,hash]of Object.entries(info.files)){if(file.includes('..')||path.isAbsolute(file)||sha(fs.readFileSync(path.join(out,file)))!==hash)throw Error('File non valido: '+file);}
 const archive=path.join(rootDir,'electron-runtime.zip');
 if(!fs.existsSync(archive)||sha(fs.readFileSync(archive))!==info.runtimeSha256){const url=`https://github.com/electron/electron/releases/download/v${info.electronVersion}/electron-v${info.electronVersion}-win32-x64.zip`;const r=await fetch(url);if(!r.ok)throw Error('Runtime HTTP '+r.status);const data=Buffer.from(await r.arrayBuffer());if(sha(data)!==info.runtimeSha256)throw Error('Runtime non valido');fs.writeFileSync(archive,data);}
 ps(`[System.IO.Compression.ZipFile]::ExtractToDirectory(${quote(archive)},${quote(path.join(out,'runtime'))})`);
 fs.renameSync(path.join(out,'runtime','electron.exe'),path.join(out,'runtime','ShooterGame.exe'));
 fs.copyFileSync(path.join(rootDir,'update.json'),path.join(out,'update.json'));
 fs.copyFileSync(path.join(out,'runtime','LICENSE'),path.join(out,'LICENSE-Electron.txt'));
 const fullZip=path.join(rootDir,'dist',name+'.zip');ps(`[System.IO.Compression.ZipFile]::CreateFromDirectory(${quote(out)},${quote(fullZip)},[System.IO.Compression.CompressionLevel]::Optimal,$true)`);
 fs.writeFileSync(fullZip+'.sha256',sha(fs.readFileSync(fullZip))+'  '+path.basename(fullZip)+'\n');return {info,fullZip};
}
async function publish({info,fullZip}){
 if(process.env.GITHUB_REPOSITORY!==repository||!process.env.GITHUB_TOKEN)throw Error('Workflow pubblico richiesto');
 const headers={Authorization:'Bearer '+process.env.GITHUB_TOKEN,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'Montaperti-Shooter-updates'};
 async function api(route,method='GET',body){const r=await fetch('https://api.github.com/repos/'+repository+route,{method,redirect:'error',headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});if(!r.ok&&r.status!==404)throw Error('GitHub HTTP '+r.status);return {status:r.status,data:await r.json()};}
 const novita=fs.existsSync(path.join(root,'NOVITA.txt'))?'\n\n**Novità**\n\n'+fs.readFileSync(path.join(root,'NOVITA.txt'),'utf8'):'';
 const tag='build-'+info.build,prior=await api('/releases/tags/'+tag);let release;
 if(prior.status===200){release=prior.data;if(!release.draft){console.log('Release già pubblicata: '+release.html_url);return;}}
 else{release=(await api('/releases','POST',{tag_name:tag,target_commitish:process.env.GITHUB_SHA,name:`Montaperti Shooter ${info.gameVersion}`,body:'Scarica **'+path.basename(fullZip)+'** (sotto, in *Assets*), estrai tutta la cartella e apri **Montaperti Shooter.exe**.\n\nIl client controlla gli aggiornamenti all’avvio e chiede prima di scaricarli: **Aggiorna e gioca** oppure **Gioca senza aggiornare**. Non serve un account GitHub.\n\nGioco '+info.gameVersion+' · Client '+info.clientVersion+' · Build '+info.build+novita+'\n\nI file Shooter-app.zip e update.json servono all’aggiornamento automatico: per il primo avvio usa lo ZIP Windows completo.',draft:true,prerelease:false})).data;}
 for(const file of [fullZip,fullZip+'.sha256',path.join(root,'Shooter-app.zip'),path.join(root,'update.json')]){
  const name=path.basename(file),data=fs.readFileSync(file),old=release.assets?.find(a=>a.name===name);
  if(old){if(old.digest&&old.digest!=='sha256:'+sha(data))throw Error('Bozza con file diverso: '+name);continue;}
  const url=new URL(release.upload_url.replace(/\{.*$/,''));if(url.origin!=='https://uploads.github.com'||url.pathname!==`/repos/${repository}/releases/${release.id}/assets`)throw Error('Upload inatteso');url.searchParams.set('name',name);
  const r=await fetch(url,{method:'POST',redirect:'error',headers:{...headers,'Content-Type':'application/octet-stream'},body:data});if(r.status!==201)throw Error('Upload HTTP '+r.status);console.log('Pubblicato allegato '+name);
 }
 const latest=await api('/releases/latest');const newer=latest.status===200&&Number(latest.data.tag_name.replace('build-',''))>info.build;
 console.log((await api('/releases/'+release.id,'PATCH',{draft:false,make_latest:newer?'false':'true'})).data.html_url);
}
if(require.main===module)build().then(result=>process.argv.includes('--build-only')?console.log(JSON.stringify({fullZip:result.fullZip,build:result.info.build})):publish(result)).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={build,publish};
