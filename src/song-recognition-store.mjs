import crypto from 'node:crypto';
const parse=(v,fallback)=>{try{return JSON.parse(v);}catch{return fallback;}};
export class SongRecognitionStore{
 constructor(db){this.db=db;db.exec(`
 CREATE TABLE IF NOT EXISTS song_name_states(name_key TEXT PRIMARY KEY,root TEXT NOT NULL,value_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS song_name_jobs(id TEXT PRIMARY KEY,root TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,reason TEXT,budget INTEGER NOT NULL,requests INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS song_name_items(job_id TEXT NOT NULL,name_key TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',phase INTEGER NOT NULL DEFAULT 0,details_json TEXT NOT NULL DEFAULT '{}',PRIMARY KEY(job_id,name_key));
 CREATE TABLE IF NOT EXISTS song_name_cache(cache_key TEXT PRIMARY KEY,result_json TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS song_name_usage(day TEXT PRIMARY KEY,requests INTEGER NOT NULL DEFAULT 0);`);
 db.prepare("UPDATE song_name_jobs SET status='interrupted',reason='service-restarted',updated_at=? WHERE status IN ('queued','running')").run(Date.now());
 }
 state(key){const r=this.db.prepare('SELECT value_json FROM song_name_states WHERE name_key=?').get(key);return r?parse(r.value_json,null):null;}
 save(state){this.db.prepare('INSERT INTO song_name_states(name_key,root,value_json) VALUES(?,?,?) ON CONFLICT(name_key) DO UPDATE SET root=excluded.root,value_json=excluded.value_json').run(state.nameKey,state.root,JSON.stringify(state));return state;}
 job(id){return this.db.prepare('SELECT * FROM song_name_jobs WHERE id=?').get(id)||null;}
 latest(root){return this.db.prepare('SELECT * FROM song_name_jobs WHERE root=? ORDER BY created_at DESC,id DESC LIMIT 1').get(root)||null;}
 unfinished(root){return this.db.prepare("SELECT * FROM song_name_jobs WHERE root=? AND status IN ('queued','running','paused','interrupted') ORDER BY created_at DESC LIMIT 1").get(root)||null;}
 create(root,mode,budget,states){const now=Date.now(),id=crypto.randomUUID();this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare("INSERT INTO song_name_jobs(id,root,mode,status,budget,created_at,updated_at) VALUES(?,?,?,'queued',?,?,?)").run(id,root,mode,budget,now,now);const put=this.db.prepare('INSERT INTO song_name_items(job_id,name_key,details_json) VALUES(?,?,?)');for(const s of states){put.run(id,s.nameKey,JSON.stringify({samples:[],nameRevision:s.nameRevision,initialName:s.displayName}));this.save({...s,history:{jobId:id,status:'queued',samples:0,updatedAt:now}});}this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}return this.job(id);}
 setJob(id,status,reason=null){this.db.prepare('UPDATE song_name_jobs SET status=?,reason=?,updated_at=? WHERE id=?').run(status,reason,Date.now(),id);return this.job(id);}
 items(id){return this.db.prepare('SELECT * FROM song_name_items WHERE job_id=? ORDER BY phase,name_key').all(id).map(r=>({...r,details:parse(r.details_json,{})}));}
 saveItem(item){this.db.prepare('UPDATE song_name_items SET status=?,phase=?,details_json=? WHERE job_id=? AND name_key=?').run(item.status,item.phase,JSON.stringify(item.details),item.job_id,item.name_key);}
 usage(){const day=new Date().toISOString().slice(0,10);return{day,requests:this.db.prepare('SELECT requests FROM song_name_usage WHERE day=?').get(day)?.requests||0};}
 reserve(job,config){const usage=this.usage();if(job.requests>=job.budget)return'budget';if(usage.requests>=config.dailyBudget)return'daily-budget';this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO song_name_usage(day,requests) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET requests=requests+1').run(usage.day);this.db.prepare('UPDATE song_name_jobs SET requests=requests+1,updated_at=? WHERE id=?').run(Date.now(),job.id);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}return null;}
 cache(key){const r=this.db.prepare('SELECT result_json,created_at FROM song_name_cache WHERE cache_key=?').get(key);return r&&r.created_at>Date.now()-30*86400e3?parse(r.result_json,null):null;}
 saveCache(key,value){this.db.prepare('INSERT OR REPLACE INTO song_name_cache VALUES(?,?,?)').run(key,JSON.stringify(value),Date.now());this.db.exec('DELETE FROM song_name_cache WHERE cache_key IN (SELECT cache_key FROM song_name_cache ORDER BY created_at DESC LIMIT -1 OFFSET 10000)');}
 summary(job){if(!job)return null;const counts={};for(const r of this.db.prepare('SELECT status,COUNT(*) AS n,SUM(phase) AS samples FROM song_name_items WHERE job_id=? GROUP BY status').all(job.id))counts[r.status]=r.n;return{id:job.id,mode:job.mode,status:job.status,reason:job.reason,budget:job.budget,requests:job.requests,counts,total:Object.values(counts).reduce((a,b)=>a+b,0),createdAt:job.created_at,updatedAt:job.updated_at};}
}
