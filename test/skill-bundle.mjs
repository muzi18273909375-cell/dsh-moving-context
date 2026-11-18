/**
 * skill-bundle.mjs — 检查 skill 里的自包含脚本跟源码一致（防漂移）。
 * 漂移了就提示运行：npm run build:skill
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSkillBundle } from '../scripts/build-skill.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const checkedIn = fs.readFileSync(path.join(here, '..', 'skill', 'scripts', 'move-session.mjs'), 'utf8');
const fresh = buildSkillBundle();

assert.equal(
  checkedIn,
  fresh,
  'skill/scripts/move-session.mjs 与源码不一致 —— 跑一次 npm run build:skill 再提交',
);

// 生成出来的东西必须能被 node 语法检查（不真正执行）
assert.ok(fresh.includes('function scanZstdFrames'), '生成的脚本里应该有帧扫描实现');
assert.ok(fresh.includes('function cmdMove'), '生成的脚本里应该有 CLI 命令');
assert.ok(!/^export /m.test(fresh), '自包含脚本里不应残留 export');

console.log('skill bundle：通过 3，失败 0');
