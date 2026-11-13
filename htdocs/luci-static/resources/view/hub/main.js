'use strict';
'require view';
'require fs';
'require ui';
'require uci';
'require poll';

/*
 * 服务合集：qBittorrent / OpenList / 1Panel / WorkBuddy2API
 *
 * 前两个由 hub-ctl 管理（支持多种运行方式切换），后两个复用各自原有的 ctl，
 * 本页只做状态汇总与常用操作入口 —— 它们已经跑稳，没必要为合并重写一遍。
 */

var HUB = '/usr/libexec/hub-ctl';
var CTL_1P = '/usr/libexec/1panel-ctl';
var CTL_WB = '/usr/libexec/workbuddy2api-ctl';

var TABS = [
	{ id: 'qb', title: 'qBittorrent' },
	{ id: 'ol', title: 'OpenList' },
	{ id: 'pn', title: '1Panel' },
	{ id: 'wb', title: 'WorkBuddy2API' }
];

/* ---------------------------------------------------------------- 工具 */

function call(tool, args) {
	return fs.exec(tool, args).then(function(res) {
		var text = ((res && res.stdout) || '') + ((res && res.stderr) || '');

		return { code: res ? res.code : 1, text: String(text).replace(/\s+$/, '') };
	}).catch(function(err) {
		return { code: 1, text: '执行失败：' + (err && err.message ? err.message : err) };
	});
}

function parseKV(text) {
	var out = {};

	(text || '').split('\n').forEach(function(line) {
		var i = line.indexOf('=');

		if (i > 0)
			out[line.substring(0, i).trim()] = line.substring(i + 1).trim();
	});

	return out;
}

function flag(v) { return String(v) === '1'; }

function badge(ok, okText, badText) {
	return E('span', { 'class': 'label ' + (ok ? 'success' : 'warning') },
		[ ok ? okText : badText ]);
}

function muted(t) {
	return E('span', { 'class': 'cbi-value-description' }, [ t ]);
}

function note(t) {
	return E('div', { 'class': 'cbi-value-description', 'style': 'margin:.4em 0' }, [ t ]);
}

function row(label, content) {
	return E('div', { 'class': 'cbi-value' }, [
		E('label', { 'class': 'cbi-value-title' }, [ label ]),
		E('div', { 'class': 'cbi-value-field' }, [ content ])
	]);
}

/* ---------------------------------------------------------------- 页面状态 */

var state = {
	hub: {}, panel: {}, wb: {},
	tab: 'qb',
	out: '',
	task: 'idle'
};

/* ---------------------------------------------------------------- 主视图 */

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('hub'),
			uci.load('1panel').catch(function() {}),
			uci.load('workbuddy2api').catch(function() {})
		]);
	},

	render: function() {
		var self = this;
		var body = E('div', { 'id': 'hub-body' });
		var outBox = E('pre', {
			'id': 'hub-out',
			'style': 'margin-top:1em;max-height:16em;overflow:auto;white-space:pre-wrap;' +
				'font-size:12px;background:var(--background-color-low,#f5f5f5);padding:.6em;border-radius:4px;display:none'
		});

		function setOut(text) {
			state.out = text || '';
			outBox.textContent = state.out;
			outBox.style.display = state.out ? '' : 'none';
		}

		function run(tool, args, label) {
			setOut((label ? '== ' + label + '\n' : '') + '执行中…');

			return call(tool, args).then(function(r) {
				setOut((label ? '== ' + label + '\n' : '') + r.text);
				return r;
			});
		}

		function saveCfg(sec, kv) {
			Object.keys(kv).forEach(function(k) {
				uci.set('hub', sec, k, String(kv[k]));
			});
			return uci.save().then(function() {
				return uci.apply();
			});
		}

		/* ---- 通用控件 ---- */

		function selectBox(cur, options, onChange) {
			var sel = E('select', { 'class': 'cbi-input-select' }, options.map(function(o) {
				return E('option', { 'value': o.value, 'selected': cur === o.value ? '' : null },
					[ o.label ]);
			}));

			sel.addEventListener('change', function() {
				onChange(sel.value);
			});
			return sel;
		}

		function textBox(cur, ph, onChange) {
			var inp = E('input', {
				'class': 'cbi-input-text',
				'value': cur || '',
				'placeholder': ph || ''
			});

			inp.addEventListener('change', function() {
				onChange(inp.value.trim());
			});
			return inp;
		}

		function btn(label, fn, cls) {
			var b = E('button', { 'class': 'cbi-button ' + (cls || 'cbi-button-action') }, [ label ]);

			b.addEventListener('click', function(ev) {
				ev.preventDefault();
				b.disabled = true;
				Promise.resolve(fn()).then(function() {
					b.disabled = false;
					return refresh(true);
				}).catch(function() { b.disabled = false; });
			});
			return b;
		}

		function actRow(svc, running) {
			return E('div', { 'style': 'display:flex;gap:.5em;flex-wrap:wrap;margin-top:.8em' }, [
				btn('安装 / 应用当前方式', function() {
					return run(HUB, [ 'install', svc ], '安装 ' + svc);
				}),
				btn('启动', function() { return run(HUB, [ 'start', svc ], '启动'); }, 'cbi-button-positive'),
				btn('停止', function() { return run(HUB, [ 'stop', svc ], '停止'); }, 'cbi-button-negative'),
				btn('重启', function() { return run(HUB, [ 'restart', svc ], '重启'); }),
				btn('日志', function() { return run(HUB, [ 'logs', svc, '40' ], '最近日志'); }, 'cbi-button-neutral'),
				btn('卸载（保留数据）', function() {
					if (!confirm('确定卸载 ' + svc + ' 吗？数据目录会保留。'))
						return Promise.resolve();
					return run(HUB, [ 'remove', svc ], '卸载');
				}, 'cbi-button-reset')
			]);
		}

		/* ---- qBittorrent ---- */

		function qbPane(st) {
			var sec = 'qbittorrent';
			var cur = st.qb_variant || 'luci';
			var running = flag(st.qb_running);

			return E('div', {}, [
				row('运行方式', selectBox(cur, [
					{ value: 'luci', label: '原生 · 官方版（qbittorrent 5.3.0）' },
					{ value: 'luci-ee', label: '原生 · 增强版（EE 5.2.4.10，反吸血）' },
					{ value: 'docker', label: '容器 · 官方版（linuxserver）' },
					{ value: 'docker-ee', label: '容器 · 增强版（p3terx，反吸血）' }
				], function(v) {
					return saveCfg(sec, { variant: v });
				})),

				row('状态', E('div', {}, [
					badge(running, '运行中', '未运行'),
					muted('  已安装：' + (st.qb_native === 'ee' ? '原生增强版'
						: st.qb_native === 'std' ? '原生官方版' : '无')),
					st.qb_ct ? muted('  · 容器：' + st.qb_ct) : null,
					flag(st.qb_conflict) ? E('div', {}, [
						note('⚠ 原生版和容器版同时存在，两者共用同一端口，只能跑一个。')
					]) : null
				])),

				row('WebUI 端口', E('div', {}, [
					textBox(st.qb_port, '8090', function(v) {
						return saveCfg(sec, { port: v || '8090' });
					}),
					flag(st.qb_port_busy) ? muted('  已在监听') : null,
					note('默认 8090。避免用 8080 —— Nikki/mihomo 默认占这个端口。')
				])),

				row('BT 监听端口', E('div', {}, [
					textBox(st.qb_bt_port, '21142', function(v) {
						return saveCfg(sec, { bt_port: v || '21142' });
					}),
					note('需要在防火墙/端口映射里放行 TCP+UDP。')
				])),

				row('下载目录', E('div', {}, [
					textBox(st.qb_downloads, '/mnt/sda1/movie', function(v) {
						return saveCfg(sec, { downloads: v });
					}),
					note('容器版里映射为 /downloads。目录不存在会自动创建。')
				])),

				row('数据目录', E('div', {}, [
					E('code', {}, [ st.qb_datadir || '' ]),
					note('配置在 ' + (st.qb_config || '') +
						'，含 qBittorrent.conf 与 BT_backup（种子与做种记录），别丢。' +
						'留空则优先用 /mnt/sda1，不可用时跟随原生版的 /etc/qBittorrent。')
				])),

				row('容器网络', selectBox(st.qb_network || 'host', [
					{ value: 'host', label: 'host（推荐，BT 连接数不受 NAT 影响）' },
					{ value: 'bridge', label: 'bridge（需要端口映射）' }
				], function(v) {
					return saveCfg(sec, { network: v });
				})),

				actRow('qbittorrent', running),

				note('提示：原生版和容器版切换时，先「卸载」再选另一种「安装」，' +
					'否则两个实现会抢同一个端口。数据目录不会被动。')
			]);
		}

		/* ---- OpenList ---- */

		function olPane(st) {
			var sec = 'openlist';
			var cur = st.ol_variant || 'openlist2';
			var running = flag(st.ol_running);

			return E('div', {}, [
				row('运行方式', selectBox(cur, [
					{ value: 'openlist2', label: '原生 · openlist2（sbwml，带 LuCI 页面）' },
					{ value: 'feeds', label: '原生 · feeds 官方 openlist' },
					{ value: 'docker', label: '容器 · openlistteam/openlist' }
				], function(v) {
					return saveCfg(sec, { variant: v });
				})),

				row('状态', E('div', {}, [
					badge(running, '运行中', '未运行'),
					muted('  已安装：' + (st.ol_native === 'openlist2' ? 'openlist2'
						: st.ol_native === 'feeds' ? 'feeds 版' : '无')),
					st.ol_ct ? muted('  · 容器：' + st.ol_ct) : null
				])),

				row('端口', E('div', {}, [
					textBox(st.ol_port, '5244', function(v) {
						return saveCfg(sec, { port: v || '5244' });
					}),
					flag(st.ol_port_busy) ? muted('  已在监听') : null
				])),

				row('数据目录', E('div', {}, [
					E('code', {}, [ st.ol_datadir || '' ]),
					note('config.json 与 data.db 都在这里。' +
						'原生 openlist2 用 /etc/openlist2，feeds 版用 /etc/openlist。' +
						'容器版容器内路径固定为 /opt/openlist/data。')
				])),

				row('容器网络', selectBox(st.ol_network || 'host', [
					{ value: 'host', label: 'host（推荐）' },
					{ value: 'bridge', label: 'bridge（需要端口映射）' }
				], function(v) {
					return saveCfg(sec, { network: v });
				})),

				actRow('openlist', running),

				note('从原生版切到容器版时，data.db 会被原地接管（同一个目录）。' +
					'切换前先停服务，避免 SQLite 的 WAL 文件处于写入状态。')
			]);
		}

		/* ---- 1Panel / WorkBuddy2API ---- */

		function simplePane(kind, st) {
			var info = kind === 'pn'
				? { title: '1Panel', ctl: CTL_1P, port: '10086', menu: 'NAS → 1Panel' }
				: { title: 'WorkBuddy2API', ctl: CTL_WB, port: '8788', menu: '服务 → WorkBuddy2API' };

			var kv = st || {};
			var port = kv.port || info.port;
			var running = flag(kv.running);

			var host = state.hub.lanip || window.location.hostname;
			var link = E('a', {
				'href': 'http://' + host + ':' + port,
				'target': '_blank',
				'class': 'cbi-button cbi-button-action',
				'style': 'display:inline-block;padding:.35em .9em;border-radius:4px'
			}, [ '打开 ' + info.title ]);

			return E('div', {}, [
				row('管理方式', E('div', {}, [
					muted('沿用各自原有的 ctl 与页面，本页只做状态汇总和入口跳转。'),
					note('详细设置请到「' + info.menu + '」页面。')
				])),

				row('状态', E('div', {}, [
					badge(running, '运行中', '未运行'),
					kv.kind ? muted('  · 当前：' + kv.kind) : null,
					kv.version ? muted('  · 版本：' + kv.version) : null,
					kv.datadir ? note('数据目录：' + kv.datadir) : null
				])),

				row('入口', E('div', {}, [
					link,
					muted('  端口 ' + port)
				])),

				E('div', { 'style': 'display:flex;gap:.5em;flex-wrap:wrap;margin-top:.8em' }, [
					btn('刷新状态', function() { return refresh(true); }),
					btn('查看日志', function() {
						return run(info.ctl, [ 'logs' ], info.title + ' 日志');
					}, 'cbi-button-neutral')
				])
			]);
		}

		/* ---- 组装 ---- */

		var tabBar = E('div', {
			'style': 'display:flex;gap:.3em;border-bottom:2px solid var(--border-color-medium,#ddd);' +
				'margin-bottom:1em;flex-wrap:wrap'
		}, TABS.map(function(t) {
			var b = E('button', {
				'class': 'cbi-button cbi-button-neutral',
				'data-tab': t.id,
				'style': 'border-radius:4px 4px 0 0;margin-bottom:-2px'
			}, [ t.title ]);

			b.addEventListener('click', function(ev) {
				ev.preventDefault();
				state.tab = t.id;
				drawTabs();
				drawBody(true);
			});
			return b;
		}));

		function drawTabs() {
			tabBar.querySelectorAll('button[data-tab]').forEach(function(b) {
				var on = b.getAttribute('data-tab') === state.tab;

				b.className = 'cbi-button ' + (on
					? 'cbi-button-action'
					: 'cbi-button-neutral');
				b.style.fontWeight = on ? 'bold' : '';
			});
		}

		function drawBody(force) {
			var st = state.hub;
			var node;

			switch (state.tab) {
			case 'qb': node = qbPane(st); break;
			case 'ol': node = olPane(st); break;
			case 'pn': node = simplePane('pn', state.panel); break;
			case 'wb': node = simplePane('wb', state.wb); break;
			default: node = E('div', {}, [ '未知页签' ]);
			}

			body.innerHTML = '';
			body.appendChild(node);
		}

		/* ---- 刷新 ---- */

		function refresh(force) {
			return Promise.all([
				call(HUB, [ 'status' ]),
				call(CTL_1P, [ 'status' ]).catch(function() { return { text: '' }; }),
				call(CTL_WB, [ 'status' ]).catch(function() { return { text: '' }; })
			]).then(function(res) {
				state.hub = parseKV(res[0].text);
				state.panel = parseKV(res[1].text);
				state.wb = parseKV(res[2].text);
				state.task = state.hub.task || 'idle';

				drawTabs();
				drawBody(force);
			});
		}

		drawTabs();
		refresh(true);

		poll.add(function() {
			return refresh(false);
		}, 5);

		return E('div', {}, [
			E('h2', {}, [ '服务合集' ]),
			E('div', { 'class': 'cbi-section' }, [
				tabBar,
				body,
				outBox
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
