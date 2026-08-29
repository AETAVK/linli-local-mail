import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const PROTECT_SCRIPT = [
  "Add-Type -AssemblyName System.Security",
  "$plain = [Console]::In.ReadToEnd()",
  "$bytes = [Text.Encoding]::UTF8.GetBytes($plain)",
  "$cipher = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($cipher))"
].join("; ");

const UNPROTECT_SCRIPT = [
  "Add-Type -AssemblyName System.Security",
  "$encoded = [Console]::In.ReadToEnd()",
  "$cipher = [Convert]::FromBase64String($encoded)",
  "$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($cipher, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))"
].join("; ");

function runPowerShell(script, stdinText) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Windows secret protection failed (${code}): ${Buffer.concat(stderr).toString("utf8").trim()}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.end(String(stdinText));
  });
}

export class SecretStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.entries = {};
    this.load();
  }

  load() {
    if (!fs.existsSync(this.filePath)) return;
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    if (parsed?.version !== 1 || typeof parsed.entries !== "object") {
      throw new Error(`Unsupported secret store: ${this.filePath}`);
    }
    this.entries = { ...parsed.entries };
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(
      temporary,
      `${JSON.stringify({ version: 1, protection: "windows-dpapi-current-user", entries: this.entries }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    fs.renameSync(temporary, this.filePath);
  }

  async set(id, secret) {
    const key = String(id || "").trim();
    if (!key) throw new Error("Secret id cannot be empty");
    const value = String(secret ?? "");
    if (!value) {
      delete this.entries[key];
      this.save();
      return;
    }
    if (process.platform !== "win32") {
      throw new Error("This build only stores API keys through Windows DPAPI");
    }
    this.entries[key] = await runPowerShell(PROTECT_SCRIPT, value);
    this.save();
  }

  async get(id) {
    const encrypted = this.entries[String(id || "")];
    if (!encrypted) return "";
    if (process.platform !== "win32") {
      throw new Error("This API key was protected with Windows DPAPI and cannot be opened on this platform");
    }
    try {
      return await runPowerShell(UNPROTECT_SCRIPT, encrypted);
    } catch (error) {
      console.warn(`Secret ${id} cannot be decrypted on this Windows account; treat as unconfigured: ${error.message}`);
      return "";
    }
  }

  has(id) {
    return Boolean(this.entries[String(id || "")]);
  }

  delete(id) {
    const key = String(id || "");
    if (!Object.hasOwn(this.entries, key)) return false;
    delete this.entries[key];
    this.save();
    return true;
  }

  ids() {
    return Object.keys(this.entries);
  }
}
