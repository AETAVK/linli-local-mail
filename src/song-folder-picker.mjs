import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
const helper = new URL('../native/linli-windows-helper.exe', import.meta.url);
import { fileURLToPath } from 'node:url';

function runPicker(initialRoot, signal) {
  return new Promise((resolve, reject) => {
    const child = execFile(fileURLToPath(helper), ['choose-song-folder'], { windowsHide: true, shell: false,
      encoding: 'utf8', maxBuffer: 65536, timeout: 300000, signal }, (error, stdout) => {
      if (error) reject(Object.assign(new Error('文件夹选择未完成，请重试。'), { status: 503 }));
      else { try { resolve(JSON.parse(stdout)); } catch { reject(Object.assign(new Error('文件夹选择返回无效数据'), { status: 502 })); } }
    });
    child.stdin.on('error', () => {}); child.stdin.end(initialRoot);
  });
}
// This only selects and validates. Catalog/settings changes require the later explicit scan.
export function createSongFolderPicker({ run = runPicker, stat = fs.stat, platform = process.platform } = {}) {
  let active = false;
  return async function choose({ initialRoot = '', signal } = {}) {
    if (platform !== 'win32') throw Object.assign(new Error('系统文件夹选择仅支持 Windows'), { status: 503 });
    if (typeof initialRoot !== 'string' || initialRoot.length > 4096 || initialRoot.includes('\0') || initialRoot && !path.isAbsolute(initialRoot))
      throw Object.assign(new Error('歌曲文件夹路径无效'), { status: 400 });
    if (active) throw Object.assign(new Error('文件夹选择窗口已打开，请先完成或取消。'), { status: 409 });
    active = true;
    try {
      const value = await run(initialRoot, signal);
      if (value?.cancelled === true && value.path == null) return { cancelled: true, path: null };
      if (value?.cancelled !== false || typeof value.path !== 'string' || value.path.length > 4096 || value.path.includes('\0') || !path.isAbsolute(value.path))
        throw Object.assign(new Error('选择的歌曲文件夹无效'), { status: 400 });
      const selected = path.resolve(value.path);
      if (!(await stat(selected)).isDirectory()) throw Object.assign(new Error('所选路径不是文件夹'), { status: 400 });
      return { cancelled: false, path: selected };
    } finally { active = false; }
  };
}
