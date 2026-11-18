#!/usr/bin/env node
/**
 * build-skill.mjs — 把 lib/core.js + src/move-session.mjs 合成一个自包含的
 * skill/scripts/move-session.mjs（拷进 ~/.dsh/skills 时不需要带 lib/）。
 *
 * 这样同一份逻辑只有一个来源，skill 里的副本由这个脚本生成；
 * test/skill-bundle.mjs 会检查「仓库里那份 == 现在生成的那份」，防止漂移。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const HEADER = `#!/usr/bin/env node
// ---------------------------------------------------------------
// 本文件由 scripts/build-skill.mjs 生成，不要手改。
// 逻辑来源：lib/core.js + src/move-session.mjs
// 改完源码跑一次：npm run build:skill
// ---------------------------------------------------------------
`;

const IMPORTS = `import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
`;

/** 去掉 import 段与 export 关键字，保留函数体 */
function stripModule(source) {
  const lines = source.split('\n');
  const kept = [];
  let skippingImport = false;
  for (const line of lines) {
    if (/^import\s/.test(line)) {
      skippingImport = !line.trimEnd().endsWith(';');
      continue;
    }
    if (skippingImport) {
      if (/from\s+['"].+['"];?\s*$/.test(line) || line.trim() === '') {
        skippingImport = false;
      }
      continue;
    }
    if (/^export\s+(const|function|let|class|async function)\b/.test(line)) {
      kept.push(line.replace(/^export\s+/, ''));
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

export function buildSkillBundle() {
  const core = stripModule(fs.readFileSync(path.join(root, 'lib', 'core.js'), 'utf8'));
  const cliFull = fs.readFileSync(path.join(root, 'src', 'move-session.mjs'), 'utf8');
  const cli = stripModule(cliFull.replace(/^#!.*\n/, ''));
  return `${HEADER}${IMPORTS}\n// ===== lib/core.js =====\n${core.trim()}\n\n// ===== src/move-session.mjs =====\n${cli.trim()}\n`;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = path.join(root, 'skill', 'scripts', 'move-session.mjs');
  const body = buildSkillBundle();
  const check = process.argv.includes('--check');
  if (check) {
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (current === body) {
      console.log(`skill 打包是最新的（${body.length} 字节）`);
    } else {
      console.error(
        `skill 打包已过期：仓库里 ${current.length} 字节，现在生成 ${body.length} 字节。\n跑一次 npm run build:skill 再提交。`,
      );
      process.exitCode = 1;
    }
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
    console.log(`已生成 ${target}（${body.length} 字节）`);
  }
}
