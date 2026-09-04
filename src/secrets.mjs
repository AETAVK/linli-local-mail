import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVICE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_HELPER_PATH = path.join(SERVICE_ROOT, "native", "linli-windows-helper.exe");

function runNativeHelper({ helperPath, args, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, args, {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      reject(new Error(`Windows secret protection helper could not start: ${error.message}`));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        const details = Buffer.concat(stderr).toString("utf8").trim();
        reject(new Error(`Windows secret protection failed (${code}): ${details}`));
        return;
      }
      resolve(Buffer.concat(stdout));
    });
    child.stdin.end(input);
  });
}

export class SecretStore {
  constructor(filePath, options = {}) {
    const { helperPath = DEFAULT_HELPER_PATH, runner = runNativeHelper } = options || {};
    if (typeof helperPath !== "string" || !helperPath) {
      throw new TypeError("SecretStore helperPath must be a non-empty string");
    }
    if (typeof runner !== "function") {
      throw new TypeError("SecretStore runner must be a function");
    }
    this.filePath = filePath;
    this.helperPath = helperPath;
    this.runner = runner;
    this.entries = {};
    this.load();
  }

  async run(command, input) {
    const output = await this.runner({
      helperPath: this.helperPath,
      args: [command],
      input: Buffer.from(input)
    });
    if (!Buffer.isBuffer(output) && !(output instanceof Uint8Array)) {
      throw new TypeError("Secret protection runner must return bytes");
    }
    return Buffer.from(output);
  }

  assertSupportedPlatform() {
    if (process.platform !== "win32" && this.runner === runNativeHelper) {
      throw new Error("This build only stores API keys through Windows DPAPI");
    }
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
    this.assertSupportedPlatform();
    const protectedValue = await this.run("dpapi-protect", Buffer.from(value, "utf8"));
    this.entries[key] = protectedValue.toString("utf8");
    this.save();
  }

  async get(id) {
    const encrypted = this.entries[String(id || "")];
    if (!encrypted) return "";
    if (process.platform !== "win32" && this.runner === runNativeHelper) {
      throw new Error("This API key was protected with Windows DPAPI and cannot be opened on this platform");
    }
    try {
      const plain = await this.run("dpapi-unprotect", Buffer.from(String(encrypted), "utf8"));
      return plain.toString("utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Secret ${id} cannot be decrypted on this Windows account; treat as unconfigured: ${message}`);
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
