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

function call(tool, args, env) {
	return fs.exec(tool, args, env).then(function(res) {
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
	pnMode: '',
	draft: {},
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

		/* 密码通过 fs.exec 的环境参数传，argv 里只有 "-"，ps 看不到明文 */
		function setPass(svc, pass, label) {
			setOut('== ' + label + '\n执行中…');

			return call(HUB, [ 'passwd', svc, '-' ], { HUB_PASS: pass }).then(function(r) {
				setOut('== ' + label + '\n' + r.text);
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

		function selectBox(cur, options, onChange, field) {
			var sel = E('select', { 'class': 'cbi-input-select' }, options.map(function(o) {
				return E('option', { 'value': o.value, 'selected': cur === o.value ? '' : null },
					[ o.label ]);
			}));

			if (field)
				sel.setAttribute('data-field', field);

			sel.addEventListener('change', function() {
				onChange(sel.value);
			});
			return sel;
		}

		function textBox(cur, ph, onChange, field) {
			var inp = E('input', {
				'class': 'cbi-input-text',
				'value': cur || '',
				'placeholder': ph || ''
			});

			if (field)
				inp.setAttribute('data-field', field);

			inp.addEventListener('change', function() {
				onChange(inp.value.trim());
			});
			return inp;
		}

		/* 密码框 + 设置按钮。刻意不带 data-field：不参与草稿收集，
		 * 免得 5 秒一次的重绘把密码留在 DOM 里。 */
		function passBox(ph, onSet) {
			var inp = E('input', {
				'class': 'cbi-input-text',
				'type': 'password',
				'placeholder': ph || '',
				'autocomplete': 'new-password',
				'style': 'max-width:16em'
			});
			var b = E('button', {
				'class': 'cbi-button cbi-button-action',
				'style': 'margin-left:.5em'
			}, [ '设置' ]);

			b.addEventListener('click', function() {
				var v = inp.value;
				if (!v)
					return;
				b.disabled = true;
				Promise.resolve(onSet(v)).then(function() {
					inp.value = '';
					b.disabled = false;
				}, function() {
					b.disabled = false;
				});
			});
			inp.addEventListener('keydown', function(ev) {
				if (ev.key === 'Enter')
					b.click();
			});
			return E('span', {}, [ inp, b ]);
		}

		/*
		 * 页面每 5 秒重绘一次，直接重建 DOM 会把用户正在输入的内容冲掉。
		 * 重绘前先把带 data-field 的输入框收集成草稿，渲染时优先取草稿。
		 */
		function collectDraft() {
			var d = {};

			body.querySelectorAll('[data-field]').forEach(function(el) {
				d[el.getAttribute('data-field')] = el.value;
			});
			return d;
		}

		function val(field, fallback) {
			var v = state.draft[field];

			return (v !== undefined && v !== '') ? v : (fallback || '');
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
					textBox(val('qb_port', st.qb_port), '8090', function(v) {
						return saveCfg(sec, { port: v || '8090' }).then(function() {
							if (flag(st.qb_running))
								return run(HUB, [ 'restart', 'qbittorrent' ], '按新端口重启');
						});
					}, 'qb_port'),
					flag(st.qb_port_busy) ? muted('  已在监听') : null,
					note('默认 8090。避免用 8080 —— Nikki/mihomo 默认占这个端口。')
				])),

				row('BT 监听端口', E('div', {}, [
					textBox(val('qb_bt', st.qb_bt_port), '21142', function(v) {
						return saveCfg(sec, { bt_port: v || '21142' }).then(function() {
							if (flag(st.qb_running))
								return run(HUB, [ 'restart', 'qbittorrent' ], '按新端口重启');
						});
					}, 'qb_bt'),
					note('需要在防火墙/端口映射里放行 TCP+UDP。')
				])),

				row('下载目录', E('div', {}, [
					textBox(val('qb_dl', st.qb_downloads), '/mnt/sda1/movie', function(v) {
						return saveCfg(sec, { downloads: v });
					}, 'qb_dl'),
					note('容器版里映射为 /downloads。目录不存在会自动创建。')
				])),

				row('数据目录', E('div', {}, [
					E('code', {}, [ st.qb_datadir || '' ]),
					muted(flag(st.qb_datalink)
						? '  · 原生版已链接到这里，与容器版共用'
						: '  · 仅在 /etc 上（sda1 不可用）'),
					note('配置在 ' + (st.qb_config || '') +
						'，含 qBittorrent.conf 与 BT_backup（种子与做种记录），别丢。' +
						'优先用 /mnt/sda1/Configs/services，安装时会自动把 /etc/qBittorrent 迁过去并换成链接。' +
						'这里的配置和种子跨刷机保留；原生版的程序本身装在 overlay 上，刷完要点一次「安装」恢复。')
				])),

				row('容器网络', selectBox(st.qb_network || 'host', [
					{ value: 'host', label: 'host（推荐，BT 连接数不受 NAT 影响）' },
					{ value: 'bridge', label: 'bridge（需要端口映射）' }
				], function(v) {
					return saveCfg(sec, { network: v });
				})),

				flag(st.docker) && !flag(st.dockerroot_ok)
					? note('⚠ Docker 数据目录在 ' + (st.dockerroot || 'overlay') +
						'，镜像会吃 overlay 空间，刷机后还会一起没掉。改到 /mnt 后容器版才能跨刷机保留（镜像不用重下）。')
					: null,

				row('WebUI 密码', E('div', {}, [
					passBox('新密码，留空不改', function(v) {
						return setPass('qbittorrent', v, '设置 qB 密码');
					}),
					note('用户名固定 admin。改完立即生效，不用手动重启。' +
						'实现方式是先把 127.0.0.1 加进免密白名单、再由本机调 qB 自己的 API，' +
						'所以以后忘了密码，从路由器本机仍然能改回来；LAN 访问照旧要密码。')
				])),

				actRow('qbittorrent', running),

				note('提示：原生版和容器版切换时不用先卸载，直接选另一种「安装」就行 —— ' +
					'ctl 会先停掉另一边并复用同一份数据。')
			]);
		}

		/* ---- OpenList ---- */

		function olPane(st) {
			var sec = 'openlist';
			var cur = st.ol_variant || 'openlist2';
			var running = flag(st.ol_running);

			return E('div', {}, [
				row('运行方式', selectBox(cur, [
					{ value: 'openlist2', label: '原生 · openlist2（sbwml，带 LuCI 页面，运行时下载）' },
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
					textBox(val('ol_port', st.ol_port), '5244', function(v) {
						return saveCfg(sec, { port: v || '5244' }).then(function() {
							if (flag(st.ol_running))
								return run(HUB, [ 'restart', 'openlist' ], '按新端口重启');
						});
					}, 'ol_port'),
					flag(st.ol_port_busy) ? muted('  已在监听') : null,
					note('原生版会同步到 openlist2 / openlist 自己的 UCI。' +
						'容器版 host 网络下固定监听 5244，要换宿主机端口请改成 bridge。')
				])),

				row('数据目录', E('div', {}, [
					E('code', {}, [ st.ol_datadir || '' ]),
					muted(flag(st.ol_datalink)
						? '  · 原生版已链接到这里，三种方式共用'
						: '  · 仅在 /etc 上（sda1 不可用）'),
					note('config.json 与 data.db 都在这里。' +
						'/etc/openlist2 与 /etc/openlist 会被链接到同一位置，' +
						'容器版挂载的也是这里（容器内 /opt/openlist/data）。' +
						'数据跨刷机保留；原生版的程序在 overlay 上，刷完要点一次「安装」。')
				])),

				row('容器网络', selectBox(st.ol_network || 'host', [
					{ value: 'host', label: 'host（推荐）' },
					{ value: 'bridge', label: 'bridge（需要端口映射）' }
				], function(v) {
					return saveCfg(sec, { network: v });
				})),

				flag(st.docker) && !flag(st.dockerroot_ok)
					? note('⚠ Docker 数据目录在 ' + (st.dockerroot || 'overlay') +
						'，镜像会吃 overlay 空间，刷机后还会一起没掉。改到 /mnt 后容器版才能跨刷机保留。')
					: null,

				row('管理员密码', E('div', {}, [
					passBox('新密码，留空不改', function(v) {
						return setPass('openlist', v, '设置 OpenList 密码');
					}),
					note('对应 OpenList 面板的 admin 账号，直接写进 data.db，不用重启。' +
						'容器版通过 docker exec 调用，容器要在运行中。')
				])),

				actRow('openlist', running),

				note('三种运行方式共用同一份 data.db：原生目录会被链接到上面那个数据目录，' +
					'切换不用搬文件，也不会丢存储挂载和账号。')
			]);
		}

		/* ---- 1Panel ---- */

		function pnPane(st) {
			var mode = state.pnMode || (st.kind === 'native' ? 'native' : 'container');
			var isC = mode === 'container';
			var pk = isC ? 'container_' : 'native_';
			var running = flag(st[isC ? 'container_running' : 'native_running']);
			var port = val('pn_port', st[pk + 'port'] || st.port || '10086');
			var user = val('pn_user', st[pk + 'username'] || st.username || '1panel');
			var pass = state.draft.pn_pass || '';
			var ent = val('pn_ent', st[pk + 'entrance'] || st.entrance || '');
			var dir = val('pn_dir', st[pk + 'datadir'] || st.datadir || '/mnt/sda1/Configs/1Panel');
			var img = val('pn_img', st.container_image || 'moelin/1panel:v2');
			var rootp = val('pn_root', st.container_rootpath || '0');

			var sub = E('div', { 'style': 'display:flex;gap:.4em;margin-bottom:.6em' }, [
				btn('容器版', function() { state.pnMode = 'container'; drawBody(true); }, isC ? 'cbi-button-action' : 'cbi-button-neutral'),
				btn('本地版', function() { state.pnMode = 'native'; drawBody(true); }, !isC ? 'cbi-button-action' : 'cbi-button-neutral')
			]);

			var passInput = E('input', {
				'class': 'cbi-input-text',
				'type': 'password',
				'value': pass,
				'placeholder': '至少 8 位，仅首次安装用',
				'data-field': 'pn_pass'
			});
			passInput.addEventListener('change', function() {
				state.draft.pn_pass = passInput.value;
			});

			function args() {
				return isC
					? [ 'container', 'install', port, user, pass, ent, dir, String(rootp), img ]
					: [ 'install', port, user, pass, ent, dir ];
			}

			function life(act) {
				return run(CTL_1P, isC ? [ 'container', act ] : [ act ], '1Panel ' + act);
			}

			return E('div', {}, [
				row('安装方式', E('div', {}, [ sub,
					note(isC ? '容器版：docker compose 跑 moelin/1panel，数据挂载在 /mnt'
						: '本地版：官方 install.sh 铺二进制，procd 托管，约 152MB 写在 overlay')
				])),

				row('状态', E('div', {}, [
					badge(running, '运行中', '未运行'),
					muted('  当前：' + (st.kind || 'none')),
					st.version ? muted('  · 版本 ' + st.version) : null,
					flag(st.conflict) ? note('⚠ 两套同时存在，会抢同一端口和数据目录。') : null
				])),

				row('端口', textBox(port, '10086', function() {}, 'pn_port')),

				row('账号', textBox(user, '1panel', function() {}, 'pn_user')),

				row('密码', E('div', {}, [ passInput,
					note('安装时写入面板数据库，之后改这里不会再生效，请到面板里改。')
				])),

				row('安全入口', E('div', {}, [ textBox(ent, '留空则自动生成', function() {}, 'pn_ent'),
					note('面板 URL 的路径后缀，例如 /abcd1234。')
				])),

				row('数据目录', E('div', {}, [ textBox(dir, '/mnt/sda1/Configs/1Panel', function() {}, 'pn_dir'),
					note('必须落在可写的挂载点上，否则安装会被拒绝（返回码 2）。')
				])),

				isC ? row('镜像', textBox(img, 'moelin/1panel:v2', function() {}, 'pn_img')) : null,

				isC ? row('挂载 root', selectBox(String(rootp), [
					{ value: '0', label: '否（推荐）' },
					{ value: '1', label: '是（面板里可浏览整机文件）' }
				], function() {}, 'pn_root')) : null,

				E('div', { 'style': 'display:flex;gap:.5em;flex-wrap:wrap;margin-top:.8em' }, [
					btn('安装', function() {
						return run(CTL_1P, args(), '安装 1Panel');
					}),
					btn('更新', function() {
						return run(CTL_1P, isC ? [ 'container', 'update' ] : [ 'update' ], '更新 1Panel');
					}),
					btn('启动', function() { return life('start'); }, 'cbi-button-positive'),
					btn('停止', function() { return life('stop'); }, 'cbi-button-negative'),
					btn('重启', function() { return life('restart'); }),
					btn('日志', function() {
						return run(CTL_1P, isC ? [ 'container', 'logs' ] : [ 'logs' ], '1Panel 日志');
					}, 'cbi-button-neutral'),
					btn('卸载', function() {
						if (!confirm('确定卸载 1Panel？数据目录会保留。'))
							return Promise.resolve();
						return run(CTL_1P, isC ? [ 'container', 'remove' ] : [ 'remove' ], '卸载 1Panel');
					}, 'cbi-button-reset')
				]),

				E('div', { 'style': 'margin-top:.6em' }, [
					E('a', {
						'href': 'http://' + (state.hub.lanip || window.location.hostname) + ':' + port,
						'target': '_blank',
						'class': 'cbi-button cbi-button-action',
						'style': 'display:inline-block;padding:.35em .9em;border-radius:4px'
					}, [ '打开面板' ])
				])
			]);
		}

		/* ---- WorkBuddy2API ---- */

		function wbPane(st) {
			var variant = val('wb_variant', st.variant || 'rust');
			var port = val('wb_port', st.port || '8788');
			var dir = val('wb_dir', st.datadir || '/mnt/sda1/Configs/workbuddy2api');
			var running = flag(st.running);

			function life(act) {
				return run(CTL_WB, [ act, variant ], 'WorkBuddy2API ' + act);
			}

			return E('div', {}, [
				row('安装方式', selectBox(variant, [
					{ value: 'rust', label: '本地 · Rust（静态单文件，推荐）' },
					{ value: 'python', label: '本地 · 原版 Python' },
					{ value: 'rust-docker', label: '容器 · Rust（ghcr.io/ytjungle666）' },
					{ value: 'python-docker', label: '容器 · 原版（ghcr.io/ardeyou）' }
				], function() {}, 'wb_variant')),

				row('状态', E('div', {}, [
					badge(running, '运行中', '未运行'),
					muted('  当前：' + (st.kind || 'none')),
					st.version ? muted('  · 版本 ' + st.version) : null
				])),

				row('端口', textBox(port, '8788', function() {}, 'wb_port')),

				row('数据目录', E('div', {}, [ textBox(dir, '/mnt/sda1/Configs/workbuddy2api', function() {}, 'wb_dir'),
					note('accounts（每账号一个 JSON）与 usage（用量日志）都在这里。' +
						'四种实现共用同一份数据，切换只换运行方式，账号和额度记录不动。')
				])),

				E('div', { 'style': 'display:flex;gap:.5em;flex-wrap:wrap;margin-top:.8em' }, [
					btn('安装', function() {
						return run(CTL_WB, [ 'install', variant, port, dir ], '安装 WorkBuddy2API');
					}),
					btn('更新', function() {
						return run(CTL_WB, [ 'update', variant ], '更新 WorkBuddy2API');
					}),
					btn('启动', function() { return life('start'); }, 'cbi-button-positive'),
					btn('停止', function() { return life('stop'); }, 'cbi-button-negative'),
					btn('重启', function() { return life('restart'); }),
					btn('日志', function() {
						return run(CTL_WB, [ 'logs', variant ], 'WorkBuddy2API 日志');
					}, 'cbi-button-neutral'),
					btn('卸载', function() {
						if (!confirm('确定卸载 ' + variant + '？数据目录会保留。'))
							return Promise.resolve();
						return run(CTL_WB, [ 'remove', variant ], '卸载');
					}, 'cbi-button-reset')
				]),

				E('div', { 'style': 'margin-top:.6em' }, [
					E('a', {
						'href': 'http://' + (state.hub.lanip || window.location.hostname) + ':' + port,
						'target': '_blank',
						'class': 'cbi-button cbi-button-action',
						'style': 'display:inline-block;padding:.35em .9em;border-radius:4px'
					}, [ '打开页面' ])
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

			/* force = 切页签/操作完成，草稿失效；否则是从状态刷新重绘，保留输入 */
			state.draft = force ? {} : collectDraft();

			switch (state.tab) {
			case 'qb': node = qbPane(st); break;
			case 'ol': node = olPane(st); break;
			case 'pn': node = pnPane(state.panel); break;
			case 'wb': node = wbPane(state.wb); break;
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
