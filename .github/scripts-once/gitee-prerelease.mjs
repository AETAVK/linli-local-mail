// One-off: mark v0.6.0/v0.7.1/v0.8.0 Gitee releases as prerelease and prepend a baseline warning.
// Runs in GitHub Actions where GITEE_TOKEN exists.
const token = process.env.GITEE_TOKEN;
if (!token) throw new Error("GITEE_TOKEN not set");
const owner = "sforlife", repo = "linli-local-mail";
const WARNING = [
  "> **⚠️ 基线修正说明（2026-08-30）**",
  ">",
  "> 本版本及之前所有 Release 锁定的兼容基线是维护者本机的重打包产物，不是 Steam 分发的官方 `0.0.9.627` `feapp.dat`。",
  "> 从 Steam 全新安装游戏后使用本版本会在这台机器上 `baseline:import` 哈希校验失败、安装中止。",
  "> 已安装旧版本并正常使用的机器不受影响，无需升级。",
  ">",
  "> **从 Steam 全新安装的用户请使用 [v0.8.1](https://gitee.com/sforlife/linli-local-mail/releases/tag/v0.8.1) 或更新版本。**",
  ""
].join("\n");

const headers = { "Content-Type": "application/json" };
for (const tag of ["v0.6.0", "v0.7.1", "v0.8.0"]) {
  const listRes = await fetch(`https://gitee.com/api/v5/repos/${owner}/${repo}/releases/tags/${tag}`, { headers });
  if (!listRes.ok) { console.error(`${tag}: fetch failed ${listRes.status}`); continue; }
  const rel = await listRes.json();
  if (rel.prerelease) { console.log(`${tag}: already prerelease, skipping`); continue; }
  const body = WARNING + (rel.body || "");
  const patch = await fetch(`https://gitee.com/api/v5/repos/${owner}/${repo}/releases/${rel.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ access_token: token, prerelease: true, body })
  });
  console.log(`${tag}: PATCH ${patch.status} ${patch.ok ? "OK" : await patch.text()}`);
}
