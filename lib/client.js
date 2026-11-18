/**
 * 客户端半边：会话行右侧「⋯」菜单里加一条「移动此聊天…」。
 *
 *   ⋯ → 移动此聊天… → 弹出工作区列表 → 选一个 → 真的搬过去
 *
 * 只往宿主已有的 slot（`sidebar.workspaces.session.menu.item`）里塞一个菜单项，
 * 弹窗自己用 DOM 画，不依赖 DSH 的 UI 组件包，避免版本漂移。
 */
window.__ModuleLoader__.load({
	id: 'dsh-moving-context',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const react = require('react');
		const h = react.createElement;

		const API = '/dsh-moving-context/api';
		const NS = 'moving-context';

		/* ------------------------------------------------------------------ *
		 * 样式（只注入一次）
		 * ------------------------------------------------------------------ */
		const CSS = `
.dsh-mc-overlay{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.38);display:flex;align-items:center;justify-content:center;font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.dsh-mc-panel{width:min(520px,calc(100vw - 32px));max-height:min(70vh,560px);display:flex;flex-direction:column;border-radius:14px;background:var(--dsw-alias-bg-elevated,#1f2126);color:var(--dsw-alias-label-primary,#e8e9ec);box-shadow:0 24px 64px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.08);overflow:hidden}
.dsh-mc-head{display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.07);font-weight:600}
.dsh-mc-sub{margin-left:auto;font-weight:400;opacity:.6;font-size:12px;max-width:52%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-mc-body{padding:8px;overflow:auto}
.dsh-mc-row{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;padding:9px 10px;border:0;border-radius:9px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}
.dsh-mc-row:hover{background:rgba(255,255,255,.08)}
.dsh-mc-row[disabled]{opacity:.45;cursor:default}
.dsh-mc-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-mc-count{flex:none;font-size:12px;opacity:.6}
.dsh-mc-foot{display:flex;align-items:center;gap:10px;padding:10px 16px;border-top:1px solid rgba(255,255,255,.07);font-size:12px;opacity:.85}
.dsh-mc-foot button{margin-left:auto;padding:5px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.16);background:transparent;color:inherit;cursor:pointer;font:inherit}
.dsh-mc-item{display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:13px;white-space:nowrap}
.dsh-mc-item:hover{background:rgba(255,255,255,.08)}
.dsh-mc-err{color:#ff8b8b}
`;

		const ensureCss = () => {
			if (typeof document === 'undefined') return;
			if (document.querySelector('style[data-plugin-css="' + NS + '"]') !== null) return;
			const tag = document.createElement('style');
			tag.dataset.plugin = 'dsh-moving-context';
			tag.dataset.pluginCss = NS;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		};

		/* ------------------------------------------------------------------ *
		 * 弹窗
		 * ------------------------------------------------------------------ */
		const el = (tag, props, children) => {
			const node = document.createElement(tag);
			if (props) for (const [key, value] of Object.entries(props)) {
				if (key === 'text') node.textContent = value;
				else if (key === 'onClick') node.addEventListener('click', value);
				else if (key === 'style') Object.assign(node.style, value);
				else node.setAttribute(key, value);
			}
			for (const child of children ?? []) if (child) node.appendChild(child);
			return node;
		};

		const move = async (sessionId, workspaceId) => {
			const response = await fetch(API + '/move', {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ sessionId, workspaceId }),
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
			return data;
		};

		const listWorkspaces = async () => {
			const response = await fetch(API + '/list', { credentials: 'same-origin' });
			const data = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
			return data.workspaces || [];
		};

		const openPicker = (sessionId, displayTitle) => {
			ensureCss();
			const dispose = () => {
				overlay.remove();
				if (typeof document.removeEventListener === 'function') document.removeEventListener('keydown', esc);
			};
			const body = el('div', { class: 'dsh-mc-body' }, [el('div', { class: 'dsh-mc-foot', text: '读工作区列表…' })]);
			const foot = el('div', { class: 'dsh-mc-foot' }, [el('span', { text: '文件、成员表、缓存三处一起改，旧文件留备份' })]);
			const close = el('button', {
				text: '关闭',
				onClick: dispose,
			});
			foot.appendChild(close);
			const panel = el('div', { class: 'dsh-mc-panel' }, [
				el('div', { class: 'dsh-mc-head' }, [
					el('span', { text: '移动此聊天' }),
					el('span', { class: 'dsh-mc-sub', text: displayTitle || sessionId, title: sessionId }),
				]),
				body,
				foot,
			]);
			const overlay = el('div', {
				class: 'dsh-mc-overlay',
				onClick: (event) => {
					if (event.target === overlay) dispose();
				},
			}, [panel]);
			document.body.appendChild(overlay);

			function esc(event) {
				if (event.key === 'Escape') dispose();
			}
			if (typeof document.addEventListener === 'function') document.addEventListener('keydown', esc);

			const renderRows = async () => {
				body.textContent = '';
				let workspaces;
				try {
					workspaces = await listWorkspaces();
				} catch (error) {
					body.appendChild(el('div', { class: 'dsh-mc-foot dsh-mc-err', text: '读不到工作区列表：' + error.message }));
					return;
				}
				for (const workspace of workspaces) {
					const row = el('button', { class: 'dsh-mc-row' }, [
						el('span', { class: 'dsh-mc-name', text: workspace.title || workspace.path }),
						el('span', { class: 'dsh-mc-count', text: workspace.sessions + ' 个对话' }),
					]);
					row.addEventListener('click', async () => {
						for (const other of body.querySelectorAll('button')) other.setAttribute('disabled', 'disabled');
						row.querySelector('.dsh-mc-count').textContent = '搬运中…';
						try {
							const result = await move(sessionId, workspace.id);
							body.textContent = '';
							body.appendChild(el('div', { class: 'dsh-mc-foot' }, [
								el('span', {
									text: '搬到「' + (result.workspace?.title ?? workspace.title) + '」了'
										+ (result.records !== undefined ? '（' + result.records + ' 条记录）' : '')
										+ (result.unchanged ? '，本来就在那儿' : ''),
								}),
							]));
							const reload = el('button', {
								text: '刷新界面',
								onClick: () => location.reload(),
							});
							foot.insertBefore(reload, close);
						} catch (error) {
							body.textContent = '';
							body.appendChild(el('div', { class: 'dsh-mc-foot dsh-mc-err', text: '没搬成：' + error.message }));
							const back = el('button', { text: '试别的', onClick: () => void renderRows() });
							foot.insertBefore(back, close);
						}
					});
					body.appendChild(row);
				}
			};
			void renderRows();
		};

		/* ------------------------------------------------------------------ *
		 * 菜单项
		 * ------------------------------------------------------------------ */
		function MoveMenuItem(props) {
			const sessionId = props?.sessionId;
			const displayTitle = props?.displayTitle;
			const [hover, setHover] = react.useState(false);
			if (typeof sessionId !== 'string') return null;
			return h(
				'div',
				{
					role: 'menuitem',
					tabIndex: 0,
					className: 'dsh-mc-item',
					style: hover ? { background: 'rgba(255,255,255,.08)' } : undefined,
					onMouseEnter: () => setHover(true),
					onMouseLeave: () => setHover(false),
					onClick: (event) => {
						event.preventDefault();
						event.stopPropagation();
						openPicker(sessionId, displayTitle);
					},
				},
				'移动此聊天…',
			);
		}

		const inject = ['slots'];

		function apply(ctx) {
			ensureCss();
			ctx.slots.inject('sidebar.workspaces.session.menu.item', function* () {
				yield ctx.slots.register(
					{
						name: 'sidebar.workspaces.session.menu.item',
						id: 'moving-context',
						order: 350,
					},
					MoveMenuItem,
				);
			});
		}

		exports.inject = inject;
		exports.apply = apply;
		exports.default = { inject, apply };
		return module.exports;
	},
});
