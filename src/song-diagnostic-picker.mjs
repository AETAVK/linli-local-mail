import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createSongFolderPicker} from './song-folder-picker.mjs';
import {validateExtraSourcePaths} from './custom-song-name-sources.mjs';
function runFiles(initialRoot,signal) {
  return new Promise((resolve,reject)=>{
    const child=execFile(fileURLToPath(new URL('../native/linli-windows-helper.exe',import.meta.url)),['choose-diagnostic-files'],
      {windowsHide:true,shell:false,encoding:'utf8',timeout:300000,maxBuffer:1024*1024,signal},(error,stdout)=>{
        if(error)return reject(Object.assign(Error('资料选择未完成，请重试。'),{status:503}));
        try{resolve(JSON.parse(stdout));}catch{reject(Object.assign(Error('资料选择返回无效数据'),{status:502}));}
      });
    child.stdin.on('error',()=>{});child.stdin.end(initialRoot);
  });
}
export function createSongDiagnosticPicker({run=runFiles,folder=createSongFolderPicker(),platform=process.platform}={}) {
  let active=false;
  return async({mode='files',initialRoot='',signal}={})=>{
    if(platform!=='win32')throw Object.assign(Error('系统资料选择仅支持 Windows'),{status:503});
    if(!['files','directory'].includes(mode))throw Object.assign(Error('资料选择方式无效'),{status:400});
    if(initialRoot)validateExtraSourcePaths([initialRoot]);
    if(active)throw Object.assign(Error('请先完成当前资料选择'),{status:409});
    active=true;
    try{
      const result=mode==='directory'?await folder({initialRoot,signal}):await run(initialRoot,signal);
      if(result?.cancelled===true)return{cancelled:true,paths:[]};
      if(result?.cancelled!==false)throw Object.assign(Error('资料选择返回无效数据'),{status:502});
      return{cancelled:false,paths:validateExtraSourcePaths(mode==='directory'?[result.path]:result.paths)};
    }finally{active=false;}
  };
}
