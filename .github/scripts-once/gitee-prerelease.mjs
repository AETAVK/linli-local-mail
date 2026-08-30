// One-off: mark v0.6.0/v0.7.1/v0.8.0 Gitee releases as prerelease and prepend a baseline warning.
// Runs in GitHub Actions where GITEE_TOKEN exists. Delete this workflow after a successful run.
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

for (const tag of ["v0.6.0", "v0.7.1", "v0.8.0"]) {
  const listRes = await fetch(`https://gitee.com/api/v5/repos/${owner}/${repo}/releases/tags/${tag}`);
  if (!listRes.ok) { console.error(`${tag}: fetch failed ${listRes.status}`); continue; }
  const rel = await listRes.json();
  if (rel.prerelease) { console.log(`${tag}: already prerelease, skipping`); continue; }
  const url = `https://gitee.com/api/v5/repos/${owner}/${repo}/releases/${rel.id}?access_token=${encodeURIComponent(token)}`;
  const patch = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      tag_name: tag,
      name: rel.name || tag,
      prerelease: "true",
      body: WARNING + (rel.body || "")
    })
  });
  console.log(`${tag}: PATCH ${patch.status} ${patch.ok ? "OK" : await patch.text()}`);
}
