'use strict';
'require view';
'require fs';
'require ui';
'require uci';
'require poll';

/*
 * 服务合集：qBittorrent / OpenList / 1Panel / WorkBuddy2API
 *
 * 版式沿用 luci-app-1panel 与 luci-app-workbuddy2api 原来的那套：
 *   顶部状态卡（hub-grid 两列）→ 配置表单（hub-form 两列网格）→ 动作按钮 → 输出。
 * 两个旧页面之所以长这样，是因为 Argon/Aurora 这类主题会把 <table> 和
 * cbi-value 的规则改得很难看；用 CSS Grid 自己排，才不受主题影响。
 */

var HUB = '/usr/libexec/hub-ctl';
var CTL_1P = '/usr/libexec/1panel-ctl';
var CTL_WB = '/usr/libexec/workbuddy2api-ctl';

var TABS = [
	{ id: 'qb', title: _('qBittorrent') },
	{ id: 'ol', title: _('OpenList') },
	{ id: 'pn', title: _('1Panel') },
	{ id: 'wb', title: _('WorkBuddy2API') }
];

var QB_VARIANTS = [
	{ value: 'luci', label: _('原生 · 官方版（qbittorrent 5.x）') },
	{ value: 'luci-ee', label: _('原生 · 增强版 EE（反吸血）') },
	{ value: 'docker', label: _('容器 · 官方版（linuxserver/qbittorrent）') },
	{ value: 'docker-ee', label: _('容器 · 增强版（p3terx/qbittorrent-enhanced）') }
];

var OL_VARIANTS = [
	{ value: 'openlist2', label: _('原生 · openlist2（sbwml，带 LuCI 页，运行时下载）') },
	{ value: 'feeds', label: _('原生 · feeds 官方 openlist') },
	{ value: 'docker', label: _('容器 · openlistteam/openlist') }
];

var WB_VARIANTS = [
	{ value: 'rust', label: _('本地 · Rust（静态单文件，推荐）') },
	{ value: 'python', label: _('本地 · 原版 Python') },
	{ value: 'rust-docker', label: _('容器 · Rust（ghcr.io/ytjungle666）') },
	{ value: 'python-docker', label: _('容器 · 原版（ghcr.io/ardeyou）') }
];

var PHASE_TEXT = {
	idle: _('空闲'),
	installing: _('安装中'),
	pulling: _('拉取镜像'),
	downloading: _('下载安装包'),
	extracting: _('解包'),
	starting: _('等待服务就绪'),
	updating: _('升级中'),
	removing: _('卸载中'),
	done: _('完成'),
	error: _('失败')
};

var CSS = [
	'.hub-wrap { overflow-x: auto; }',
	'.hub-grid { display: grid; grid-template-columns: 11rem minmax(14rem, 1fr); min-width: 30rem; }',
	'.hub-k { padding: .45rem .6rem; font-weight: bold;',
	'  border-bottom: 1px solid rgba(128,128,128,.18); }',
	'.hub-c { padding: .45rem .6rem; border-bottom: 1px solid rgba(128,128,128,.18);',
	'  min-width: 0; word-break: break-word; }',
	'.hub-full { grid-column: 1 / -1; }',
	'.hub-form { display: grid; grid-template-columns: 11rem minmax(12rem, 26rem);',
	'  gap: .5rem .8rem; align-items: start; }',
	'.hub-form > label { padding-top: .35rem; }',
	'.hub-form input[type=text], .hub-form input[type=password], .hub-form select {',
	'  width: 100%; box-sizing: border-box; }',
	'.hub-actions .btn { margin-right: .5rem; margin-bottom: .5rem; }',
	'.hub-tabs { display: flex; flex-wrap: wrap; gap: .4rem; margin: 1.2rem 0 0;',
	'  border-bottom: 1px solid rgba(128,128,128,.3); }',
	'.hub-tab { padding: .5rem 1.1rem; cursor: pointer; border: 1px solid transparent;',
	'  border-bottom: 0; border-radius: .35rem .35rem 0 0; background: transparent;',
	'  color: inherit; font: inherit; margin-bottom: -1px; }',
	'.hub-tab.on { border-color: rgba(128,128,128,.3); background: rgba(128,128,128,.12);',
	'  font-weight: bold; }',
	'.hub-tab .hub-tag { font-size: .8em; opacity: .75; }',
	'.hub-subtabs { display: flex; flex-wrap: wrap; gap: .4rem; margin: .2rem 0 1rem;',
	'  border-bottom: 1px solid rgba(128,128,128,.3); }',
	'.hub-task { margin-top: 1rem; padding: .6rem .8rem; border-left: 3px solid #3b82f6;',
	'  background: rgba(59,130,246,.08); }',
	'.hub-task.err { border-left-color: #dc2626; background: rgba(220,38,38,.08); }',
	'.hub-task.ok { border-left-color: #16a34a; background: rgba(22,163,74,.08); }',
	'.hub-warn { color: #d97706; }',
	'.hub-up { color: #dc2626; font-weight: bold; }',
	'.hub-alert { margin: .8rem 0; padding: .6rem .8rem; border-left: 3px solid #d97706;',
	'  background: rgba(217,119,6,.09); }',
	'.hub-alert.err { border-left-color: #dc2626; background: rgba(220,38,38,.09); }',
	'.hub-head { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }',
	'.hub-c code { word-break: break-all; }'
].join('\n');

/* ---------------------------------------------------------------- 工具 */

function call(tool, args, env) {
	return fs.exec(tool, args, env).then(function(res) {
		var text = ((res && res.stdout) || '') + ((res && res.stderr) || '');

		return { code: res ? res.code : 1, text: String(text).replace(/\s+$/, '') };
	}).catch(function(err) {
		return { code: 1, text: _('执行失败：') + (err && err.message ? err.message : err) };
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

/* disks 一行一个候选：disk=/mnt/sda1:123456 */
function parseDisks(text) {
	return (text || '').split('\n').map(function(line) {
		var m = /^disk=(.+):(\d+)$/.exec(line.trim());

		return m ? { mount: m[1], free: parseInt(m[2], 10) } : null;
	}).filter(function(x) { return x; });
}

function flag(v) { return String(v) === '1'; }

function int(v) { return parseInt(v, 10) || 0; }

function vnum(v) { return String(v || '').replace(/^v/, ''); }

function mb(kb) {
	var n = int(kb);

	if (!n)
		return '—';

	return n >= 1048576 ? (n / 1048576).toFixed(1) + ' GB' : Math.round(n / 1024) + ' MB';
}

function badge(ok, okText, badText) {
	return E('span', { 'class': 'label ' + (ok ? 'success' : 'warning') }, [ ok ? okText : badText ]);
}

function muted(text) {
	return E('span', { 'class': 'cbi-value-description' }, [ text ]);
}

function link(url, text) {
	if (!url)
		return muted('—');

	return E('a', { 'href': url, 'target': '_blank', 'rel': 'noopener' }, [ text || url ]);
}

/* 任务阶段：installing:luci / pulling:xxx / done / error:... */
function parseTask(s) {
	var raw = String(s || 'idle');
	var i = raw.indexOf(':');

	return i > 0
		? { phase: raw.substring(0, i), detail: raw.substring(i + 1) }
		: { phase: raw, detail: '' };
}

function busy(phase) {
	return phase === 'pulling' || phase === 'downloading' || phase === 'extracting'
		|| phase === 'installing' || phase === 'starting' || phase === 'updating'
		|| phase === 'removing';
}

function variantLabel(list, v) {
	for (var i = 0; i < list.length; i++)
		if (list[i].value === v)
			return list[i].label;

	return v || '—';
}

/* ---------------------------------------------------------------- 主视图 */

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('hub'),
			uci.load('1panel').catch(function() {}),
			uci.load('workbuddy2api').catch(function() {}),
			call(CTL_1P, [ 'latest' ]).catch(function() { return { text: '' }; }),
			call(CTL_1P, [ 'disks' ]).catch(function() { return { text: '' }; })
		]);
	},

	render: function(results) {
		var state = {
			hub: {}, panel: {}, wb: {},
			tab: 'qb',
			pnMode: '',
			latest: parseKV(results[3] ? results[3].text : '').latest || '',
			disks: parseDisks(results[4] ? results[4].text : ''),
			sig: ''
		};

		var tabWrap = E('div', { 'class': 'hub-tabs' });
		var headWrap = E('div');
		var paneWrap = E('div');

		var out = E('pre', {
			'id': 'hub-out',
			'style': 'max-height:18rem;overflow:auto;white-space:pre-wrap;word-break:break-all;margin:1rem 0 0'
		}, [ _('（还没有执行任何操作）') ]);

		function setOut(text) {
			out.textContent = text || _('（无输出）');
		}

		function run(tool, args, label) {
			setOut(_('正在执行：') + label + ' ...');

			return call(tool, args).then(function(res) {
				setOut('$ ' + tool.split('/').pop() + ' ' + args.join(' ') + '\n\n'
					+ (res.text || _('（无输出）')));

				return refresh(true);
			});
		}

		/* 密码走环境变量传，argv 里只有 "-"，ps 看不到明文 */
		function setPass(svc, pass, label) {
			setOut(_('正在执行：') + label + ' ...');

			return call(HUB, [ 'passwd', svc, '-' ], { HUB_PASS: pass }).then(function(res) {
				setOut('$ hub-ctl passwd ' + svc + ' -\n\n' + (res.text || _('（无输出）')));

				return refresh(true);
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

		function clear(node) {
			while (node.firstChild)
				node.removeChild(node.firstChild);
		}

		/* ---------------- 通用零件 ---------------- */

		function button(label, fn, opts) {
			opts = opts || {};

			return E('button', {
				'class': 'btn cbi-button' + (opts.primary ? ' cbi-button-apply' : '')
					+ (opts.danger ? ' cbi-button-reset' : ''),
				'disabled': opts.disabled ? 'disabled' : null,
				'click': function(ev) {
					ev.preventDefault();

					if (opts.confirm && !window.confirm(opts.confirm))
						return;

					return fn();
				}
			}, [ label ]);
		}

		function field(label, value, type, placeholder, onChange, hint) {
			var input = E('input', {
				'type': type || 'text',
				'class': 'cbi-input-text',
				'placeholder': placeholder || '',
				'value': value === undefined || value === null ? '' : String(value)
			});

			if (onChange)
				input.addEventListener('change', function() {
					return onChange(input.value.trim());
				});

			return {
				input: input,
				nodes: [
					E('label', {}, [ label ]),
					hint ? E('div', {}, [
						input,
						E('div', { 'class': 'cbi-value-description', 'style': 'margin-top:.3rem' }, [ hint ])
					]) : input
				]
			};
		}

		function selectField(label, cur, options, onChange) {
			var sel = E('select', { 'class': 'cbi-input-select' }, options.map(function(o) {
				return E('option', { 'value': o.value, 'selected': cur === o.value ? '' : null },
					[ o.label ]);
			}));

			if (onChange)
				sel.addEventListener('change', function() {
					return onChange(sel.value);
				});

			return { input: sel, nodes: [ E('label', {}, [ label ]), sel ] };
		}

		/* 密码 + 「设置」按钮。不放进 hub-form 的 saveCfg 流程，单独调 ctl。 */
		function passField(label, placeholder, onSet, hint) {
			var input = E('input', {
				'type': 'password',
				'class': 'cbi-input-text',
				'placeholder': placeholder || _('新密码，留空不改'),
				'autocomplete': 'new-password'
			});

			var btn = button(_('设置'), function() {
				var v = input.value;

				if (!v) {
					ui.addNotification(null, E('p', {}, [ _('先填一个密码') ]), 'warning');
					return;
				}

				btn.disabled = true;

				return Promise.resolve(onSet(v)).then(function() {
					input.value = '';
					btn.disabled = false;
				}, function() {
					btn.disabled = false;
				});
			});

			var box = E('div', { 'style': 'display:flex;gap:.5rem;align-items:center' },
				[ input, btn ]);

			if (hint)
				box.appendChild(E('div', {
					'class': 'cbi-value-description',
					'style': 'margin-top:.3rem;flex-basis:100%'
				}, [ hint ]));

			box.style.flexWrap = 'wrap';

			return { input: input, nodes: [ E('label', {}, [ label ]), box ] };
		}

		/* 状态卡：两列 grid，整行元素（警告/任务）另算 */
		function statusCard(items) {
			var grid = E('div', { 'class': 'hub-grid' });

			items.forEach(function(it) {
				if (Array.isArray(it)) {
					grid.appendChild(E('div', { 'class': 'hub-k' }, [ it[0] ]));
					grid.appendChild(E('div', { 'class': 'hub-c' },
						Array.isArray(it[1]) ? it[1] : [ it[1] ]));
				}
				else {
					grid.appendChild(E('div', { 'class': 'hub-full' }, [ it ]));
				}
			});

			return E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'hub-wrap' }, [ grid ])
			]);
		}

		function taskBox(task) {
			var t = parseTask(task);

			if (!busy(t.phase) && t.phase !== 'error' && t.phase !== 'done')
				return null;

			var cls = 'hub-task' + (t.phase === 'error' ? ' err' : (t.phase === 'done' ? ' ok' : ''));

			return E('div', { 'class': cls }, [
				E('strong', {}, [ PHASE_TEXT[t.phase] || t.phase ]),
				t.detail ? E('span', {}, [ ' ' + t.detail ]) : '',
				t.phase === 'error'
					? E('div', { 'style': 'margin-top:.4rem' }, [
						muted(_('点「查看日志」看完整输出，日志在 /var/run/hub-task/ 下。'))
					])
					: ''
			]);
		}

		function alertBox(text, cls) {
			return E('div', { 'class': 'hub-alert' + (cls ? ' ' + cls : '') }, [
				E('div', {}, [ text ])
			]);
		}

		function actions(nodes) {
			return E('div', { 'class': 'cbi-section hub-actions' }, nodes);
		}

		function openLink(text, host, port) {
			return E('a', {
				'class': 'btn cbi-button cbi-button-action',
				'href': 'http://' + (host || window.location.hostname) + ':' + port,
				'target': '_blank',
				'rel': 'noopener'
			}, [ text ]);
		}

		/* ---------------- qBittorrent ---------------- */

		function qbHead(st) {
			var v = st.qb_variant || 'luci';
			var running = flag(st.qb_running);
			var port = st.qb_port || '8090';
			var net = st.qb_network || 'host';
			var hostPort = net === 'bridge' ? (st.qb_host_port || port) : port;
			var kind = st.qb_native;
			var items = [];

			items.push([ _('状态'), E('div', { 'class': 'hub-head' }, [
				E('button', {
					'class': 'btn cbi-button ' + (running ? 'cbi-button-success' : 'cbi-button-negative'),
					'disabled': 'disabled',
					'style': 'cursor:default;min-width:13rem;opacity:1'
				}, [ running ? _('qBittorrent 正在运行') : _('qBittorrent 未运行') ]),
				running ? openLink(_('打开 WebUI'), st.lanip, hostPort) : ''
			]) ]);

			items.push([ _('运行方式'), E('span', {}, [
				E('code', {}, [ variantLabel(QB_VARIANTS, v) ]),
				muted('  ' + _('已装：') + (kind === 'ee' ? _('原生增强版')
					: kind === 'std' ? _('原生官方版') : _('无'))),
				st.qb_ct ? muted(' · ' + _('容器 ') + st.qb_ct) : ''
			]) ]);

			items.push([ _('监听端口'), E('span', {}, [
				net === 'bridge'
					? E('span', {}, [ _('宿主机 '), String(hostPort), ' → ', _('容器 '), String(port) ])
					: String(port),
				' ',
				flag(st.qb_port_busy) ? badge(true, _('已监听'), '') : muted(_('未监听'))
			]) ]);

			items.push([ _('数据目录'), E('span', {}, [
				E('code', {}, [ st.qb_datadir || '—' ]),
				flag(st.qb_datalink)
					? muted('  ' + _('原生版已链接到此处，与容器版共用'))
					: muted('  ' + _('未链接（数据在 /etc 上）'))
			]) ]);

			items.push([ _('配置目录'), E('span', {}, [
				E('code', {}, [ st.qb_config || '—' ]),
				E('div', { 'class': 'cbi-value-description' }, [
					_('qBittorrent.conf 与 BT_backup（种子、做种记录）都在这里。')
				])
			]) ]);

			items.push([ _('数据盘剩余'), mb(st.qb_config_free_kb || st.data_free_kb) ]);
			items.push([ _('overlay 剩余'), mb(st.overlay_free_kb) ]);

			if (flag(st.qb_conflict))
				items.push(alertBox(_('原生版和容器版同时存在。两者共用同一个端口，同一时刻只能跑一个 —— 直接选另一种「安装」会自动停掉另一边。')));

			if (flag(st.docker) && !flag(st.dockerroot_ok))
				items.push(alertBox(_('Docker 数据目录在 ') + (st.dockerroot || 'overlay')
					+ _('，镜像会吃 overlay 空间，刷机后还会一起没掉。改到 /mnt 后容器版才能跨刷机保留。')));

			var task = taskBox(st.task);

			if (task)
				items.push(task);

			return statusCard(items);
		}

		function qbPane(st) {
			var sec = 'qbittorrent';
			var v = st.qb_variant || 'luci';
			var running = flag(st.qb_running);
			var inFlight = busy(parseTask(st.task).phase);

			function restartIfRunning(label) {
				if (!running)
					return Promise.resolve();

				return run(HUB, [ 'restart', 'qbittorrent' ], label);
			}

			var fVar = selectField(_('运行方式'), v, QB_VARIANTS, function(x) {
				return saveCfg(sec, { variant: x });
			});

			var fPort = field(_('WebUI 端口'), st.qb_port || '8090', 'text', '8090',
				function(x) {
					return saveCfg(sec, { port: x || '8090' })
						.then(function() { return restartIfRunning(_('按新端口重启')); });
				},
				_('默认 8090。别用 8080 —— Nikki / mihomo 默认占那个端口。改完自动重启。'));

			var fBt = field(_('BT 监听端口'), st.qb_bt_port || '21142', 'text', '21142',
				function(x) {
					return saveCfg(sec, { bt_port: x || '21142' })
						.then(function() { return restartIfRunning(_('按新端口重启')); });
				},
				_('需要在防火墙或端口映射里放行 TCP + UDP。'));

			var fDir = field(_('下载目录'), st.qb_downloads || '/mnt/sda1/movie', 'text',
				'/mnt/sda1/movie',
				function(x) {
					return saveCfg(sec, { downloads: x });
				},
				_('容器版里映射为 /downloads。目录不存在会自动创建。'));

			var fData = field(_('数据目录'), st.qb_datadir || '', 'text',
				'/mnt/sda1/Configs/services/qbittorrent',
				function(x) {
					return saveCfg(sec, { datadir: x }).then(function() {
						return restartIfRunning(_('按新数据目录迁移并重启'));
					});
				},
				_('配置、种子、做种记录都放这里。改成别的路径后，下次启动会把原目录内容迁过去、')
					+ _('再把 /etc/qBittorrent 换成指向新位置的链接，数据不会丢。留空用默认位置。'));

			var fNet = selectField(_('容器网络'), st.qb_network || 'host', [
				{ value: 'host', label: _('host（推荐，BT 连接数不受 NAT 影响）') },
				{ value: 'bridge', label: _('bridge（需要端口映射）') }
			], function(x) {
				return saveCfg(sec, { network: x }).then(function() {
					return refresh(true);
				});
			});

			/* bridge 才有意义：宿主机侧端口可以和容器内不同 */
			var fHost = (st.qb_network || 'host') === 'bridge'
				? field(_('映射端口'), st.qb_host_port || st.qb_port || '8090', 'text', '8090',
					function(x) {
						return saveCfg(sec, { host_port: x || st.qb_port || '8090' })
							.then(function() { return restartIfRunning(_('按新映射端口重启')); });
					},
					_('宿主机侧端口 → 容器内端口。容器里仍是上面那个 WebUI 端口，')
						+ _('这里只改对外映射，方便避开已被占用的端口。BT 端口保持 1:1 映射。'))
				: null;

			var fPass = passField(_('WebUI 密码'), _('新密码，留空不改'),
				function(v2) { return setPass('qbittorrent', v2, _('设置 qB 密码')); },
				_('用户名固定 admin。实现方式是先把 127.0.0.1 加进免密白名单、')
					+ _('再由本机调 qB 自己的 API，所以忘了密码时从路由器上仍能改回来；LAN 访问照旧要密码。'));

			var ops = [
				button(inFlight ? _('安装进行中…') : _('安装 / 应用当前方式'),
					function() { return run(HUB, [ 'install', 'qbittorrent' ], _('安装 qBittorrent')); },
					{ primary: true, disabled: inFlight }),
				button(_('启动'), function() { return run(HUB, [ 'start', 'qbittorrent' ], _('启动')); },
					{ primary: true, disabled: inFlight }),
				button(_('停止'), function() { return run(HUB, [ 'stop', 'qbittorrent' ], _('停止')); },
					{ disabled: inFlight }),
				button(_('重启'), function() { return run(HUB, [ 'restart', 'qbittorrent' ], _('重启')); },
					{ disabled: inFlight }),
				button(_('查看日志'), function() { return run(HUB, [ 'logs', 'qbittorrent', '60' ], _('最近日志')); }),
				button(_('卸载（保留数据）'), function() {
					return run(HUB, [ 'remove', 'qbittorrent' ], _('卸载 qBittorrent'));
				}, {
					danger: true,
					disabled: inFlight,
					confirm: _('会停掉并删除 qBittorrent 的程序与容器，数据目录保留。继续？')
				})
			];

			if (running)
				ops.push(openLink(_('打开 WebUI'), st.lanip, st.qb_port || '8090'));

			return E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('qBittorrent 配置') ]),
				E('div', { 'class': 'cbi-map-descr' }, [
					_('四种运行方式任选一种：原生官方版、原生增强版（EE，反吸血）、容器官方版、容器增强版。'),
					E('br'),
					_('四种共用同一份数据目录，切换只是换运行方式，配置、种子、做种记录都留着，'),
					_('直接点「安装 / 应用当前方式」就会停掉另一种并接上同一份数据。')
				]),
				E('div', { 'class': 'hub-form', 'style': 'margin-top:1rem' },
					[].concat(fVar.nodes, fPort.nodes, fBt.nodes, fDir.nodes,
						fData.nodes, fNet.nodes, fHost ? fHost.nodes : [], fPass.nodes)),
				actions(ops)
			]);
		}

		/* ---------------- OpenList ---------------- */

		function olHead(st) {
			var v = st.ol_variant || 'openlist2';
			var running = flag(st.ol_running);
			var port = st.ol_port || '5244';
			var net = st.ol_network || 'host';
			var hostPort = net === 'bridge' ? (st.ol_host_port || port) : port;
			var kind = st.ol_native;
			var items = [];

			items.push([ _('状态'), E('div', { 'class': 'hub-head' }, [
				E('button', {
					'class': 'btn cbi-button ' + (running ? 'cbi-button-success' : 'cbi-button-negative'),
					'disabled': 'disabled',
					'style': 'cursor:default;min-width:13rem;opacity:1'
				}, [ running ? _('OpenList 正在运行') : _('OpenList 未运行') ]),
				running ? openLink(_('打开面板'), st.lanip, hostPort) : ''
			]) ]);

			items.push([ _('运行方式'), E('span', {}, [
				E('code', {}, [ variantLabel(OL_VARIANTS, v) ]),
				muted('  ' + _('已装：') + (kind === 'openlist2' ? 'openlist2'
					: kind === 'feeds' ? _('feeds 官方版') : _('无'))),
				st.ol_ct ? muted(' · ' + _('容器 ') + st.ol_ct) : ''
			]) ]);

			items.push([ _('监听端口'), E('span', {}, [
				net === 'bridge'
					? E('span', {}, [ _('宿主机 '), String(hostPort), ' → ', _('容器 5244') ])
					: String(port),
				' ',
				flag(st.ol_port_busy) ? badge(true, _('已监听'), '') : muted(_('未监听'))
			]) ]);

			items.push([ _('数据目录'), E('span', {}, [
				E('code', {}, [ st.ol_datadir || '—' ]),
				flag(st.ol_datalink)
					? muted('  ' + _('原生版已链接到此处，三种方式共用'))
					: muted('  ' + _('未链接（数据在 /etc 上）'))
			]) ]);

			items.push([ _('数据盘剩余'), mb(st.ol_config_free_kb || st.data_free_kb) ]);
			items.push([ _('overlay 剩余'), mb(st.overlay_free_kb) ]);

			if (flag(st.ol_conflict))
				items.push(alertBox(_('原生版和容器版同时存在，共用同一个端口，同一时刻只能跑一个。')));

			if (flag(st.docker) && !flag(st.dockerroot_ok))
				items.push(alertBox(_('Docker 数据目录在 ') + (st.dockerroot || 'overlay')
					+ _('，镜像会吃 overlay 空间，刷机后还会一起没掉。改到 /mnt 后容器版才能跨刷机保留。')));

			var task = taskBox(st.task);

			if (task)
				items.push(task);

			return statusCard(items);
		}

		function olPane(st) {
			var sec = 'openlist';
			var v = st.ol_variant || 'openlist2';
			var running = flag(st.ol_running);
			var inFlight = busy(parseTask(st.task).phase);

			function restartIfRunning(label) {
				if (!running)
					return Promise.resolve();

				return run(HUB, [ 'restart', 'openlist' ], label);
			}

			var fVar = selectField(_('运行方式'), v, OL_VARIANTS, function(x) {
				return saveCfg(sec, { variant: x });
			});

			var fPort = field(_('端口'), st.ol_port || '5244', 'text', '5244',
				function(x) {
					return saveCfg(sec, { port: x || '5244' })
						.then(function() { return restartIfRunning(_('按新端口重启')); });
				},
				_('原生版会同步到 openlist2 / openlist 自己的 UCI；')
					+ _('容器版 host 网络下固定监听 5244，要换宿主机端口请改成 bridge。'));

			var fData = field(_('数据目录'), st.ol_datadir || '', 'text',
				'/mnt/sda1/Configs/services/openlist',
				function(x) {
					return saveCfg(sec, { datadir: x }).then(function() {
						return restartIfRunning(_('按新数据目录迁移并重启'));
					});
				},
				_('config.json 与 data.db 都在这里。/etc/openlist2 与 /etc/openlist 会被链接到同一位置，')
					+ _('容器版挂的也是这里（容器内 /opt/openlist/data）。改路径后启动时会自动迁移，数据不会丢。'));

			var fNet = selectField(_('容器网络'), st.ol_network || 'host', [
				{ value: 'host', label: _('host（推荐）') },
				{ value: 'bridge', label: _('bridge（需要端口映射）') }
			], function(x) {
				return saveCfg(sec, { network: x }).then(function() {
					return refresh(true);
				});
			});

			var fHost = (st.ol_network || 'host') === 'bridge'
				? field(_('映射端口'), st.ol_host_port || st.ol_port || '5244', 'text', '5244',
					function(x) {
						return saveCfg(sec, { host_port: x || st.ol_port || '5244' })
							.then(function() { return restartIfRunning(_('按新映射端口重启')); });
					},
					_('宿主机侧端口 → 容器内 5244。容器里固定监听 5244，这里只改对外映射。'))
				: null;

			var fPass = passField(_('管理员密码'), _('新密码，留空不改'),
				function(v2) { return setPass('openlist', v2, _('设置 OpenList 密码')); },
				_('对应面板的 admin 账号，直接写进 data.db，不用重启。')
					+ _('容器版通过 docker exec 调用，容器要在运行中。'));

			var ops = [
				button(inFlight ? _('安装进行中…') : _('安装 / 应用当前方式'),
					function() { return run(HUB, [ 'install', 'openlist' ], _('安装 OpenList')); },
					{ primary: true, disabled: inFlight }),
				button(_('启动'), function() { return run(HUB, [ 'start', 'openlist' ], _('启动')); },
					{ primary: true, disabled: inFlight }),
				button(_('停止'), function() { return run(HUB, [ 'stop', 'openlist' ], _('停止')); },
					{ disabled: inFlight }),
				button(_('重启'), function() { return run(HUB, [ 'restart', 'openlist' ], _('重启')); },
					{ disabled: inFlight }),
				button(_('查看日志'), function() { return run(HUB, [ 'logs', 'openlist', '60' ], _('最近日志')); }),
				button(_('卸载（保留数据）'), function() {
					return run(HUB, [ 'remove', 'openlist' ], _('卸载 OpenList'));
				}, {
					danger: true,
					disabled: inFlight,
					confirm: _('会停掉并删除 OpenList 的程序与容器，数据目录保留。继续？')
				})
			];

			if (running)
				ops.push(openLink(_('打开面板'), st.lanip, st.ol_port || '5244'));

			return E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('OpenList 配置') ]),
				E('div', { 'class': 'cbi-map-descr' }, [
					_('三种运行方式：openlist2（sbwml，带自己的 LuCI 页面，安装时现下预编译包）、'),
					_('feeds 官方 openlist、容器版。'),
					E('br'),
					_('三种共用同一份 data.db 与 config.json，切换不用搬文件，网盘挂载和账号都留着。')
				]),
				E('div', { 'class': 'hub-form', 'style': 'margin-top:1rem' },
					[].concat(fVar.nodes, fPort.nodes, fData.nodes, fNet.nodes,
						fHost ? fHost.nodes : [], fPass.nodes)),
				actions(ops)
			]);
		}

		/* ---------------- 1Panel ---------------- */

		function pnMode(st) {
			if (state.pnMode)
				return state.pnMode;

			return st.kind === 'native' ? 'native' : 'container';
		}

		function pnHead(st) {
			var kind = st.kind || 'none';
			var running = flag(st.running) && kind !== 'none';
			var items = [];

			items.push([ _('状态'), E('div', { 'class': 'hub-head' }, [
				E('button', {
					'class': 'btn cbi-button ' + (running ? 'cbi-button-success' : 'cbi-button-negative'),
					'disabled': 'disabled',
					'style': 'cursor:default;min-width:13rem;opacity:1'
				}, [ kind === 'container' ? _('1Panel 正在运行（容器版）')
					: kind === 'native' ? _('1Panel 正在运行（本地版）')
					: _('1Panel 未运行') ]),
				running && st.address ? E('a', {
					'class': 'btn cbi-button cbi-button-action',
					'href': st.address, 'target': '_blank', 'rel': 'noopener'
				}, [ _('打开面板') ]) : ''
			]) ]);

			if (kind !== 'none') {
				var verCell = [ E('code', {}, [ st.version || '—' ]) ];
				var newv = state.latest || st.latest || '';

				if (newv && st.version && vnum(newv) !== vnum(st.version))
					verCell.push(E('span', { 'class': 'hub-up', 'style': 'margin-left:.6rem' },
						[ _('有新版本 %s').format(newv) ]));
				else if (newv && st.version)
					verCell.push(muted(' ' + _('（已是最新）')));

				items.push([ _('版本'), verCell ]);
				items.push([ _('访问地址'), link(st.address) ]);
			}
			else {
				items.push([ _('版本'), muted(_('安装后显示')) ]);
				items.push([ _('访问地址'), muted(_('安装后可用')) ]);
			}

			items.push([ _('运行方式'), kind === 'container'
				? E('span', {}, [ _('容器（docker compose）'), muted(' '),
					E('code', {}, [ st.container_image || '—' ]) ])
				: kind === 'native' ? E('span', {}, [ _('本地进程（procd 托管）') ])
				: muted('—') ]);

			items.push([ _('监听端口'), st.port || '—' ]);
			items.push([ _('登录账号'), st.username || '—' ]);
			items.push([ _('入口路径'), st.entrance ? E('code', {}, [ st.entrance ]) : muted(_('未设置')) ]);
			items.push([ _('数据目录'), E('span', {}, [
				E('code', {}, [ st.datadir || '—' ]),
				kind === 'container' && st.container_datadir && st.container_datadir !== st.datadir
					? muted(' ' + st.container_datadir) : ''
			]) ]);
			items.push([ _('数据盘剩余'), mb(st.data_free_kb) ]);
			items.push([ _('overlay 剩余'), mb(st.overlay_free_kb) ]);

			if (flag(st.docker))
				items.push([ _('Docker 剩余'), mb(st.docker_free_kb) ]);

			if (flag(st.conflict))
				items.push(alertBox(_('容器版和本地版同时装了，会抢同一个端口和数据目录。请在下面卸载其中一个。')));

			var task = taskBox(st.task);

			if (task)
				items.push(task);

			return statusCard(items);
		}

		function pnPane(st) {
			var mode = pnMode(st);
			var isC = mode === 'container';
			var inFlight = busy(parseTask(st.task).phase);
			var present = flag(isC ? st.container_present : st.native_present);
			var other = flag(isC ? st.native_present : st.container_present);

			var sub = E('div', { 'class': 'hub-subtabs' }, [
				tabButton(_('容器版'), isC, function() {
					state.pnMode = 'container';
					state.sig = '';
					drawAll(true);
				}),
				tabButton(_('本地版'), !isC, function() {
					state.pnMode = 'native';
					state.sig = '';
					drawAll(true);
				})
			]);

			function ctl(args, label) {
				return run(CTL_1P, args, label);
			}

			if (present) {
				var running = flag(isC ? st.container_running : st.native_running);
				var cur = (isC ? st.container_version : st.native_version) || '';
				var newv = state.latest || st.latest || '';
				var canUpdate = newv && cur && vnum(newv) !== vnum(cur);
				var ops = [];

				if (canUpdate)
					ops.push(button(_('更新到 %s').format(newv),
						function() { return ctl(isC ? [ 'container', 'update' ] : [ 'update' ], _('更新 1Panel')); },
						{ primary: true, disabled: inFlight }));

				ops.push(running
					? button(_('停止'), function() {
						return ctl(isC ? [ 'container', 'stop' ] : [ 'stop' ], _('停止 1Panel'));
					}, { disabled: inFlight })
					: button(_('启动'), function() {
						return ctl(isC ? [ 'container', 'start' ] : [ 'start' ], _('启动 1Panel'));
					}, { primary: true, disabled: inFlight }));

				ops.push(button(_('重启'), function() {
					return ctl(isC ? [ 'container', 'restart' ] : [ 'restart' ], _('重启 1Panel'));
				}, { disabled: inFlight }));

				ops.push(button(_('检查更新'), function() {
					return ctl([ 'latest' ], _('检查更新'));
				}));

				ops.push(button(_('查看日志'), function() {
					return ctl(isC ? [ 'container', 'logs' ] : [ 'logs' ], _('1Panel 日志'));
				}));

				if (running && st.address)
					ops.push(E('a', {
						'class': 'btn cbi-button cbi-button-action',
						'href': st.address, 'target': '_blank', 'rel': 'noopener'
					}, [ _('打开面板') ]));

				ops.push(button(_('卸载'), function() {
					return ctl(isC ? [ 'container', 'remove' ] : [ 'remove' ], _('卸载 1Panel'));
				}, {
					danger: true,
					disabled: inFlight,
					confirm: _('会停掉并删除 1Panel，数据目录保留。继续？')
				}));

				ops.push(button(_('卸载并删除数据'), function() {
					return ctl(isC ? [ 'container', 'remove', 'purge' ] : [ 'remove', 'purge' ],
						_('卸载并删除数据'));
				}, {
					danger: true,
					disabled: inFlight,
					confirm: _('会连同面板的数据库、备份、应用一起删掉，不可恢复。继续？')
				}));

				return E('div', { 'class': 'cbi-section hub-actions' }, [
					sub,
					E('h3', {}, [ isC ? _('容器版 1Panel') : _('本地版 1Panel') ]),
					E('div', { 'class': 'cbi-map-descr' }, [
						isC
							? _('用 docker compose 跑 1Panel v2。数据挂在 /mnt 下，容器里看到的路径和宿主机一致。')
							: _('官方 install.sh 铺二进制，procd 托管 1panel-core 与 1panel-agent，不走容器。')
					]),
					E('div', { 'style': 'margin-top:1rem' }, ops),
					taskBox(st.task)
				]);
			}

			var fPort = field(_('监听端口'), (isC ? st.container_port : st.native_port) || '10086');
			var fUser = field(_('登录账号'), (isC ? st.container_username : st.native_username) || '1panel');
			var fPass = field(_('登录密码'), '', 'password', _('至少 8 位'));
			var fEnt = field(_('入口路径'), '', 'text', _('例如 panel-8x3k，别用 entrance'));
			var fDir = dirField(st, (isC ? st.container_datadir : st.native_datadir)
				|| '/mnt/sda1/Configs/1Panel');
			var fImg = isC ? field(_('镜像'), st.container_image || 'moelin/1panel:v2') : null;

			var chkRoot = E('input', { 'type': 'checkbox' });
			var rootRow = [
				E('label', {}, [ _('挂载 root 路径') ]),
				E('div', {}, [
					E('label', {}, [ chkRoot, ' ', _('把宿主机根目录挂到容器的 /ahost') ]),
					E('div', {}, [ muted(_('面板里要浏览整机文件、或装需要碰 /etc 的应用时才勾。')) ])
				])
			];

			var blockedNote = other
				? alertBox(isC
					? _('已安装本地版 1Panel，不能再装容器版')
					: _('已安装容器版 1Panel，不能再装本地版'))
				: null;

			var installBtn = button(inFlight ? _('安装进行中…') : _('开始安装'),
				function() {
					if (!fPass.input.value || fPass.input.value.length < 8) {
						ui.addNotification(null, E('p', {}, [ _('密码至少 8 位') ]), 'warning');
						return;
					}

					if (!/^[A-Za-z0-9._-]+$/.test(fEnt.input.value)) {
						ui.addNotification(null, E('p', {}, [
							_('入口路径只能用字母、数字、点、下划线和连字符')
						]), 'warning');
						return;
					}

					if (fDir.input.value.indexOf('/mnt/') !== 0) {
						ui.addNotification(null, E('p', {}, [
							_('数据目录必须在 /mnt 下：面板的数据库、备份、应用都写这里')
						]), 'warning');
						return;
					}

					return ctl(isC
						? [ 'container', 'install', fPort.input.value, fUser.input.value,
							fPass.input.value, fEnt.input.value, fDir.input.value,
							chkRoot.checked ? '1' : '0', fImg.input.value ]
						: [ 'install', fPort.input.value, fUser.input.value,
							fPass.input.value, fEnt.input.value, fDir.input.value ],
						_('安装 1Panel'));
				}, { primary: true, disabled: inFlight || other });

			return E('div', { 'class': 'cbi-section' }, [
				sub,
				E('h3', {}, [ isC ? _('安装容器版 1Panel') : _('安装本地版 1Panel') ]),
				E('div', { 'class': 'cbi-map-descr' }, [
					isC
						? _('从 Docker Hub 拉官方镜像（moelin/1panel），用 docker compose 起容器。')
						: _('从官方源拉安装包，用官方 install.sh 安装，OpenWrt 上用 procd 托管。'),
					E('br'),
					_('端口、账号、密码、入口都由首次初始化时写进面板；数据目录必须在 /mnt 下。')
				]),
				blockedNote || '',
				flag(st.docker) || !isC ? '' : alertBox(_('Docker 没在运行，容器版装不了。先确认 docker 服务和 socket 正常。'), 'err'),
				E('div', { 'class': 'hub-form', 'style': 'margin-top:1rem' },
					[].concat(fPort.nodes, fUser.nodes, fPass.nodes, fEnt.nodes,
						fDir.nodes, fImg ? fImg.nodes : [], isC ? rootRow : [])),
				actions([ installBtn ]),
				taskBox(st.task)
			]);
		}

		/* 1Panel 的数据目录字段：带磁盘下拉 + 校验提示 */
		function dirField(st, value) {
			var input = E('input', {
				'type': 'text',
				'class': 'cbi-input-text',
				'value': value || ''
			});

			var opts = state.disks.map(function(d) {
				return E('option', { 'value': d.mount + '/Configs/1Panel' },
					[ d.mount + '/Configs/1Panel  (' + _('剩余 %s').format(mb(d.free)) + ')' ]);
			});

			var sel = E('select', {
				'class': 'cbi-input-select',
				'change': function(ev) { input.value = ev.target.value; }
			}, [ E('option', { 'value': '' }, [ _('从检测到的磁盘里选…') ]) ].concat(opts));

			return {
				input: input,
				nodes: [
					E('label', {}, [ _('数据目录') ]),
					E('div', {}, [
						E('div', { 'style': 'margin-bottom:.35rem' }, [ sel ]),
						input,
						muted(' ' + _('必须在 /mnt 下；面板的数据库、备份、应用都写这里'))
					])
				]
			};
		}

		/* ---------------- WorkBuddy2API ---------------- */

		function wbHead(st) {
			var running = flag(st.running);
			var port = st.port || '8788';
			var items = [];

			items.push([ _('状态'), E('div', { 'class': 'hub-head' }, [
				E('button', {
					'class': 'btn cbi-button ' + (running ? 'cbi-button-success' : 'cbi-button-negative'),
					'disabled': 'disabled',
					'style': 'cursor:default;min-width:13rem;opacity:1'
				}, [ running ? _('WorkBuddy2API 正在运行') : _('WorkBuddy2API 未运行') ]),
				running ? openLink(_('打开页面'), st.lanip, port) : ''
			]) ]);

			items.push([ _('运行方式'), E('span', {}, [
				E('code', {}, [ variantLabel(WB_VARIANTS, st.kind) ]),
				st.version ? muted('  ' + _('版本 ') + st.version) : ''
			]) ]);

			items.push([ _('监听端口'), E('span', {}, [
				String(port),
				' ',
				flag(st.listening) ? badge(true, _('已监听'), '') : muted(_('未监听'))
			]) ]);

			items.push([ _('访问地址'), running ? link('http://' + (st.lanip || window.location.hostname) + ':' + port)
				: muted(_('启动后可用')) ]);

			items.push([ _('数据目录'), E('code', {}, [ st.datadir || '—' ]) ]);
			items.push([ _('账号数'), st.accounts !== undefined ? String(st.accounts) : '—' ]);
			items.push([ _('数据盘剩余'), mb(st.data_free_kb) ]);
			items.push([ _('overlay 剩余'), mb(st.overlay_free_kb) ]);

			var task = taskBox(st.task);

			if (task)
				items.push(task);

			return statusCard(items);
		}

		function wbPane(st) {
			var inFlight = busy(parseTask(st.task).phase);
			var installed = flag(st.installed) || (st.kind && st.kind !== 'none');
			var cur = st.kind && st.kind !== 'none' ? st.kind : 'rust';

			function ctl(args, label) {
				return run(CTL_WB, args, label);
			}

			if (installed) {
				var running = flag(st.running);
				var ops = [
					button(_('更新'), function() { return ctl([ 'update', cur ], _('更新 WorkBuddy2API')); },
						{ primary: true, disabled: inFlight }),
					running
						? button(_('停止'), function() { return ctl([ 'stop', cur ], _('停止')); },
							{ disabled: inFlight })
						: button(_('启动'), function() { return ctl([ 'start', cur ], _('启动')); },
							{ primary: true, disabled: inFlight }),
					button(_('重启'), function() { return ctl([ 'restart', cur ], _('重启')); },
						{ disabled: inFlight }),
					button(_('查看日志'), function() { return ctl([ 'logs', cur ], _('WorkBuddy2API 日志')); }),
					button(_('卸载'), function() { return ctl([ 'remove', cur ], _('卸载')); }, {
						danger: true,
						disabled: inFlight,
						confirm: _('会停掉并删除当前实现，数据目录保留。继续？')
					})
				];

				if (running)
					ops.push(openLink(_('打开页面'), st.lanip, st.port || '8788'));

				return E('div', { 'class': 'cbi-section hub-actions' }, [
					E('h3', {}, [ _('WorkBuddy2API') ]),
					E('div', { 'class': 'cbi-map-descr' }, [
						_('当前运行的是 '), E('code', {}, [ variantLabel(WB_VARIANTS, cur) ]),
						'。', _('想换实现请先卸载，再在下面选另一种安装 —— 账号与用量记录共用同一份数据，不会丢。')
					]),
					E('div', { 'style': 'margin-top:1rem' }, ops),
					taskBox(st.task)
				]);
			}

			var fVar = selectField(_('安装方式'), 'rust', WB_VARIANTS);
			var fPort = field(_('端口'), st.port || '8788', 'text', '8788');
			var fDir = field(_('数据目录'), st.datadir || '/mnt/sda1/Configs/workbuddy2api', 'text',
				'/mnt/sda1/Configs/workbuddy2api', null,
				_('accounts（每账号一个 JSON）与 usage（用量日志）都在这里。')
					+ _('四种实现共用同一份数据，切换只换运行方式，账号和额度记录不动。'));

			return E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('安装 WorkBuddy2API') ]),
				E('div', { 'class': 'cbi-map-descr' }, [
					_('把 WorkBuddy / CodeBuddy 的账号转成 OpenAI 兼容接口。四种实现任选一种：'),
					E('br'),
					_('本地 Rust（静态单文件，最省内存）、本地原版 Python、容器 Rust、容器原版。')
				]),
				E('div', { 'class': 'hub-form', 'style': 'margin-top:1rem' },
					[].concat(fVar.nodes, fPort.nodes, fDir.nodes)),
				actions([
					button(inFlight ? _('安装进行中…') : _('开始安装'), function() {
						return ctl([ 'install', fVar.input.value, fPort.input.value,
							fDir.input.value ], _('安装 WorkBuddy2API'));
					}, { primary: true, disabled: inFlight })
				]),
				taskBox(st.task)
			]);
		}

		/* ---------------- 页签 ---------------- */

		function tabButton(title, on, onclick) {
			return E('button', {
				'class': 'hub-tab' + (on ? ' on' : ''),
				'click': function(ev) {
					ev.preventDefault();
					return onclick();
				}
			}, [ title ]);
		}

		function runningOf(id) {
			switch (id) {
			case 'qb': return flag(state.hub.qb_running);
			case 'ol': return flag(state.hub.ol_running);
			case 'pn': return flag(state.panel.running);
			case 'wb': return flag(state.wb.running);
			default: return false;
			}
		}

		function drawTabs() {
			clear(tabWrap);

			TABS.forEach(function(t) {
				var on = state.tab === t.id;
				var tag = runningOf(t.id) ? _('（运行中）') : '';

				tabWrap.appendChild(E('button', {
					'class': 'hub-tab' + (on ? ' on' : ''),
					'click': function(ev) {
						ev.preventDefault();
						state.tab = t.id;
						state.sig = '';
						drawAll(true);
					}
				}, [ t.title, tag ? E('span', { 'class': 'hub-tag' }, [ ' ' + tag ]) : '' ]));
			});
		}

		/* ---------------- 组装 / 刷新 ---------------- */

		function signature() {
			var h = state.hub, p = state.panel, w = state.wb;

			return [
				state.tab, state.pnMode,
				h.task, h.docker, h.dockerroot_ok, h.mnt,
				h.qb_variant, h.qb_running, h.qb_native, h.qb_ct, h.qb_port,
				h.qb_port_busy, h.qb_datalink, h.qb_datadir, h.qb_conflict,
				h.ol_variant, h.ol_running, h.ol_native, h.ol_ct, h.ol_port,
				h.ol_port_busy, h.ol_datalink, h.ol_datadir, h.ol_conflict,
				p.kind, p.task, p.running, p.version, p.latest,
				p.container_present, p.native_present,
				p.container_running, p.native_running, p.conflict,
				w.kind, w.running, w.task, w.version, w.installed, w.port,
				state.latest
			].join('|');
		}

		function drawAll(force) {
			var sig = signature();

			/* 用户在表单里打字时不能被轮询重画，只有状态真的变了才重建 */
			if (!force && sig === state.sig)
				return;

			state.sig = sig;
			drawTabs();

			clear(headWrap);
			clear(paneWrap);

			switch (state.tab) {
			case 'qb':
				headWrap.appendChild(qbHead(state.hub));
				paneWrap.appendChild(qbPane(state.hub));
				break;
			case 'ol':
				headWrap.appendChild(olHead(state.hub));
				paneWrap.appendChild(olPane(state.hub));
				break;
			case 'pn':
				headWrap.appendChild(pnHead(state.panel));
				paneWrap.appendChild(pnPane(state.panel));
				break;
			case 'wb':
				headWrap.appendChild(wbHead(state.wb));
				paneWrap.appendChild(wbPane(state.wb));
				break;
			}
		}

		function refresh(force) {
			return Promise.all([
				call(HUB, [ 'status' ]),
				call(CTL_1P, [ 'status' ]).catch(function() { return { text: '' }; }),
				call(CTL_WB, [ 'status' ]).catch(function() { return { text: '' }; })
			]).then(function(res) {
				state.hub = parseKV(res[0].text);
				state.panel = parseKV(res[1].text);
				state.wb = parseKV(res[2].text);
				state.latest = state.panel.latest || state.latest;

				drawAll(force);
			});
		}

		drawAll(true);

		poll.add(function() {
			return refresh(false);
		}, 5);

		return E('div', {}, [
			E('style', {}, [ CSS ]),
			E('h2', {}, [ _('服务合集') ]),
			E('div', { 'class': 'cbi-map-descr' }, [
				_('qBittorrent、OpenList、1Panel、WorkBuddy2API 收在一个页面里，用上面的页签切换。'),
				E('br'),
				_('前两个可以在多种运行方式之间切换（原生 / 容器），数据目录统一到 /mnt 下，'),
				_('切换时自动迁移，配置、种子、账号都不会丢；后两个沿用各自原有的安装逻辑。')
			]),
			tabWrap,
			headWrap,
			paneWrap,
			out
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
