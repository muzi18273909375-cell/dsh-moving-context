/**
 * 客户端半边的冒烟测试：在假 DOM + 假 __ModuleLoader__ 里加载 lib/client.js，
 * 确认它能注册、能画菜单项、点击能开弹窗（fetch 用假的）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8');

let passed = 0;
const ok = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok  ' + name);
};

// ---- 极简 DOM ----
class Node_ {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.textContent = '';
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  insertBefore(child) {
    this.children.unshift(child);
    return child;
  }
  remove() {
    this.removed = true;
  }
  setAttribute(k, v) {
    this.attributes[k] = v;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  querySelector() {
    return new Node_('span');
  }
  querySelectorAll() {
    return this.children.filter((c) => c.tagName === 'button');
  }
  get classList() {
    return { add() {}, remove() {} };
  }
  get className() {
    return this.attributes.class ?? '';
  }
  set className(value) {
    this.attributes.class = value;
  }
}

const document_ = {
  head: new Node_('head'),
  body: new Node_('body'),
  createElement: (tag) => new Node_(tag),
  querySelector: () => null,
  addEventListener() {},
  removeEventListener() {},
};

const localStorageCalls = [];
globalThis.document = document_;
globalThis.window = globalThis;
globalThis.location = { reload: () => localStorageCalls.push('reload') };
globalThis.fetch = async (url) => ({
  ok: true,
  status: 200,
  json: async () =>
    url.includes('/list')
      ? { workspaces: [{ id: 'ws-b', title: '工作区 B', path: 'B', sessions: 3 }] }
      : { ok: true, workspace: { id: 'ws-b', title: '工作区 B' }, records: 40, frames: 2 },
});

const reactStub = {
  createElement: (tag, props, ...children) => ({ tag, props, children }),
  useState: (initial) => [initial, () => {}],
};

let loaded;
globalThis.__ModuleLoader__ = {
  load: ({ id, factory }) => {
    loaded = { id, exports: factory((name) => (name === 'react' ? reactStub : {})) };
  },
};

// 客户端模块里没有 import，直接求值
new Function(source)();

ok('模块被 __ModuleLoader__ 接住，导出了 apply/inject', () => {
  assert.equal(loaded.id, 'dsh-moving-context');
  assert.equal(typeof loaded.exports.apply, 'function');
  assert.deepEqual(loaded.exports.inject, ['slots']);
});

const registered = [];
const ctx = {
  slots: {
    inject(name, fn) {
      registered.push({ name, viaInject: true });
      fn();
    },
    register(definition, component) {
      registered.push({ name: definition.name, component });
    },
  },
};

ok('apply 往会话行菜单里注册了菜单项', () => {
  loaded.exports.apply(ctx);
  const hit = registered.find((r) => r.name === 'sidebar.workspaces.session.menu.item' && r.component);
  assert.ok(hit, '没有注册 sidebar.workspaces.session.menu.item');
  assert.equal(typeof hit.component, 'function');
});

ok('样式只注入一次', () => {
  const styles = document_.head.children.filter((c) => c.tagName === 'style');
  assert.equal(styles.length, 1);
});

ok('菜单项渲染出「移动此聊天…」', () => {
  const Component = registered.find((r) => r.component).component;
  const element = Component({ sessionId: 'session-1', displayTitle: '某对话' });
  assert.equal(element.children[0], '移动此聊天…');
  assert.equal(typeof element.props.onClick, 'function');
});

ok('点菜单项会拉工作区列表并画在弹窗里', async () => {
  const Component = registered.find((r) => r.component).component;
  const element = Component({ sessionId: 'session-1', displayTitle: '某对话' });
  element.props.onClick({ preventDefault() {}, stopPropagation() {} });
  const overlay = document_.body.children.at(-1);
  assert.equal(overlay.tagName, 'div');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const panel = overlay.children[0];
  const body = panel.children.find((c) => c.className === 'dsh-mc-body');
  const rows = body.children.filter((c) => c.tagName === 'button');
  assert.equal(rows.length, 1, '工作区行没画出来');
});

console.log(`\n客户端层：通过 ${passed}，失败 0`);
