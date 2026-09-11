const SYSTEM_CODES=new Set(['ENOENT','EACCES','EPERM','EINVAL','EIO','ENOTDIR','EISDIR','ENOSPC','EMFILE','ENFILE','ETIMEDOUT','ECONNREFUSED','ECONNRESET','ABORT_ERR']);
export function diagnosticCode(value){
 if(typeof value!=='string'||value.length>80)return null;
 if((SYSTEM_CODES.has(value)||/^E[A-Z0-9_]+$/.test(value)||/^(?:ERR_SQLITE|SQLITE|DEBUG|MAPPING|VISION)_[A-Z0-9_]+$/.test(value))&&!/(?:TOKEN|PASSWORD|SECRET|COOKIE)/.test(value))return value;
 return null;
}
export function diagnosticReason(value){
 return typeof value==='string'&&value.length<=80&&/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(value)&&!/(?:token|password|secret|cookie)/.test(value)?value:'unknown';
}
export function diagnosticError(error,phase){
 const code=diagnosticCode(error?.code)||diagnosticCode(error?.message);
 const status=Number.isInteger(error?.status)&&error.status>=100&&error.status<=599?error.status:null;
 const ownPhase=diagnosticReason(error?.phase);
 return{phase:ownPhase==='unknown'?diagnosticReason(phase):ownPhase,code,sqliteCode:Number.isInteger(error?.errcode)&&error.errcode>=0&&error.errcode<=65535?error.errcode:null,httpStatus:status,category:code==='ENOENT'?'not-found':['EACCES','EPERM'].includes(code)?'access-denied':/^(?:ERR_)?SQLITE_/.test(code||'')?'database':status===409?'busy':status>=500?'service-error':'unknown',
 summary:code||'Diagnostic component unavailable',errno:Number.isSafeInteger(error?.errno)&&Math.abs(error.errno)<10000000?error.errno:null,codeOmitted:typeof error?.code==='string'&&code===null,at:Date.now(),rawExceptionIncluded:false};
}
