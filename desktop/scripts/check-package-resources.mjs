/**
 * 安装包资源检查：electron-builder 产出 unpacked app 后，逐文件对比源代码里的
 * prompts/ 与 skills/ 是否都进了 resources/。缺一个 prompt，打包后启动或写正文才炸。
 *
 * 用法：node desktop/scripts/check-package-resources.mjs [mac|win|linux]
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const ROOT = process.cwd();
const release = join(ROOT, "release");
const kind = process.argv[2];

function hash(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function walk(dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    if (ent.name === ".DS_Store") continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

async function files(root) {
  const map = new Map();
  if (!existsSync(root)) return map;
  for (const p of await walk(root)) {
    map.set(p.slice(root.length + 1), hash(await readFile(p)));
  }
  return map;
}

async function resourceDirs() {
  if (!existsSync(release)) return [];
  const names = await readdir(release);
  const mac = names
    .filter((n) => n === "mac" || n.startsWith("mac-"))
    .map((n) => join(release, n, "Talemate.app", "Contents", "Resources"));
  const win = [join(release, "win-unpacked", "resources")];
  const linux = [join(release, "linux-unpacked", "resources")];
  const all = { mac, win, linux };
  if (kind === undefined) return Object.values(all).flat().filter(existsSync);
  if (!(kind in all)) throw new Error(`未知平台：${kind}`);
  return all[kind].filter(existsSync);
}

const targets = await resourceDirs();
if (targets.length === 0) {
  console.error("[resources] 没有找到 unpacked resources；先跑 desktop:package --dir");
  process.exit(1);
}

let failed = false;
for (const target of targets) {
  for (const folder of ["prompts", "skills"]) {
    const source = await files(join(ROOT, folder));
    const packed = await files(join(target, folder));
    const missing = [...source.keys()].filter((rel) => !packed.has(rel));
    const diff = [...source.keys()].filter((rel) => packed.has(rel) && packed.get(rel) !== source.get(rel));
    console.log(
      `[resources] ${target}: ${folder} source=${source.size} packed=${packed.size} missing=${missing.length} diff=${diff.length}`,
    );
    if (missing.length || diff.length) {
      failed = true;
      for (const rel of missing) console.error(`  missing ${folder}/${rel}`);
      for (const rel of diff) console.error(`  diff ${folder}/${rel}`);
    }
  }
}
process.exit(failed ? 1 : 0);
