'use strict';
'require view';
'require fs';
'require ui';
'require uci';
'require poll';

/*
 * 服务合集：qBittorrent / OpenList / 1Panel / WorkBuddy2API
 *
 * 版式与 luci-app-1panel、luci-app-workbuddy2api 各自的页面完全一致：
 *   顶部状态卡（hub-grid 两列）→ 通用设置（hub-form 两列网格）→ 方式页签 → 安装/操作区 → 输出
 * 每个服务用同一套结构，只是页签里的「方式」不同：
 *   qBittorrent   原生·官方版 / 原生·增强版 / 容器·官方版 / 容器·增强版
 *   OpenList      openlist2 / feeds 官方版 / 容器版
 *   1Panel        容器安装 / 本地安装
 *   WorkBuddy2API 本地·原版 / 容器·原版 / 本地·Rust / 容器·Rust
 *
 * 不用 <table> 也不用 cbi-value：Argon/Aurora 这类主题对 th/td 和
 * .cbi-value-title 有高特异性 !important 规则，会把表头和数据行拆成不同盒模型。
 */

var HUB = '/usr/libexec/hub-ctl';
var CTL_1P = '/usr/libexec/1panel-ctl';
var CTL_WB = '/usr/libexec/workbuddy2api-ctl';

var SVCS = [
	{ id: 'qb', title: _('qBittorrent') },
	{ id: 'ol', title: _('OpenList') },
	{ id: 'pn', title: _('1Panel') },
	{ id: 'wb', title: _('WorkBuddy2API') }
];

var QB_MODES = [
	{
		id: 'luci',
		title: _('原生·官方版'),
		how: _('apk 装 qbittorrent，procd 托管 /usr/bin/qbittorrent-nox'),
		notes: [
			_('界面就是 feeds 里的 luci-app-qbittorrent，配置、日志两页。'),
			_('会连带装 Qt6 与 libtorrent，约 37MB 落在 overlay。'),
			_('刷机后程序会没，数据在 /mnt 上不会丢，重新点一次安装即可。')
		]
	},
	{
		id: 'luci-ee',
		title: _('原生·增强版'),
		how: _('apk 装 qbittorrent-enhanced-edition（c0re100 fork）'),
		notes: [
			_('比官方版多出反吸血、Peer 白/黑名单、自动封禁未知客户端、上下行阈值。'),
			_('版本 5.2.4.x，跟官方 5.3 差一档，依赖同一套 Qt6。'),
			_('和官方版互斥（CONFLICTS），装这个会先卸官方版。')
		]
	},
	{
		id: 'docker',
		title: _('容器·官方版'),
		how: _('docker compose 起 linuxserver/qbittorrent'),
		notes: [
			_('配置在数据目录的 config/ 下，端口写在 compose 里，不受 init 脚本影响。'),
			_('镜像落在 docker 数据盘，不占 overlay；docker 数据目录不在 /mnt 时刷机会丢镜像。'),
			_('BT 建议用 host 网络，bridge 下连接数受 NAT 限制。')
		]
	},
	{
		id: 'docker-ee',
		title: _('容器·增强版'),
		how: _('docker compose 起 p3terx/qbittorrent-enhanced'),
		notes: [
			_('容器版的增强版，反吸血在 WebUI 的「连接」设置里。'),
			_('同样把配置与种子写在数据目录的 config/ 下。'),
			_('与容器·官方版共用同一个容器名，装这个会替换掉那个。')
		]
	}
];

var OL_MODES = [
	{
		id: 'openlist2',
		title: _('原生·openlist2'),
		how: _('sbwml 的 openlist2，带自己的 LuCI 页面'),
		notes: [
			_('官方源里没有这个包，安装时从作者的 GitHub release 下预编译包（约 22MB）。'),
			_('原生版的数据在 /etc/openlist2，启动时从上面那个通用目录复制过去、停止时写回。'),
			_('菜单在「NAS → OpenList2」，本页只管装和启停。')
		]
	},
	{
		id: 'feeds',
		title: _('原生·feeds 版'),
		how: _('apk 装 openlist（immortalwrt feeds 里的官方包）'),
		notes: [
			_('不带 LuCI 页面，只有 /etc/init.d/openlist 和 /usr/bin/openlist。'),
			_('原生版的数据在 /etc/openlist，同样与通用目录来回同步，和另两种共用一份库。'),
			_('要改端口就改上面的通用端口，会同步进 openlist 自己的 UCI。')
		]
	},
	{
		id: 'docker',
		title: _('容器版'),
		how: _('docker compose 起 openlistteam/openlist'),
		notes: [
			_('官方镜像，容器内固定监听 5244，数据挂在通用数据目录。'),
			_('host 网络下宿主机端口只能是 5244；要换端口请用 bridge 并填映射端口。'),
			_('镜像在 docker 数据盘，刷机不会丢（前提是 data-root 在 /mnt）。')
		]
	}
];

var PN_MODES = [
	{ id: 'container', title: _('容器安装') },
	{ id: 'native', title: _('本地安装') }
];

/* WorkBuddy2API 的四套实现，顺序与原来那个页面一致 */
var WB_MODES = [
	{
		id: 'python',
		title: _('本地·原版'),
		how: _('官方 OpenWrt 包（apk/ipk），Python 实现'),
		notes: [
			_('procd 托管 python3 -m wb_proxy，参数全部走 /etc/config/workbuddy2api。'),
			_('会连带装 python3 等依赖，约 15MB 落在 overlay。'),
			_('网关地址 http://<路由器IP>:<端口>/v1，看板在根路径。')
		],
		fieldLabel: _('版本'),
		fieldHint: _('留空 = 上游最新 release，例如 v2.0.7')
	},
	{
		id: 'python-docker',
		title: _('容器·原版'),
		how: _('官方镜像 ghcr.io/ardeyouxipianyi/workbuddy2api-hub'),
		notes: [
			_('docker compose 起 wb-proxy，host 网络，容器内端口就是宿主端口。'),
			_('账号挂 /app/accounts、用量挂 /app/usage，都指向数据目录下的同一份。'),
			_('不占 overlay，镜像约 200MB 落在 docker 数据盘。')
		],
		fieldLabel: _('镜像标签'),
		fieldHint: _('留空 = 上游最新，例如 v2.0.7')
	},
	{
		id: 'rust',
		title: _('本地·Rust'),
		how: _('Tjungle666 的 Rust 重写分支，单文件静态 musl 二进制'),
		notes: [
			_('无 Python 运行时依赖，约 20MB 落在 overlay，procd 托管 /usr/bin/wb-backend。'),
			_('上游现在只有 tag 没有 release 资产，ctl 会自动从同版本镜像里把二进制抠出来。'),
			_('功能对齐上游 v2.0.1，面板与 API 路径一致。')
		],
		fieldLabel: _('版本'),
		fieldHint: _('留空 = 上游最新 tag，例如 v2.0.1.2')
	},
	{
		id: 'rust-docker',
		title: _('容器·Rust'),
		how: _('Rust 版镜像 ghcr.io/ytjungle666/workbuddy2api-hub'),
		notes: [
			_('docker compose 起 wb-proxy，host 网络，整个数据目录挂到容器的 /data。'),
			_('镜像自带的多架构产物，arm64 可用；不占 overlay。')
		],
		fieldLabel: _('镜像标签'),
		fieldHint: _('留空 = 上游最新，例如 2.0.1.2（镜像标签不带 v）')
	}
];

var PHASE_TEXT = {
	idle: _('空闲'),
	installing: _('安装'),
	pulling: _('拉取镜像'),
	downloading: _('下载'),
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
	'  gap: .5rem .8rem; align-items: center; }',
	'.hub-form input[type=text], .hub-form input[type=password], .hub-form select {',
	'  width: 100%; box-sizing: border-box; }',
	'.hub-actions .btn { margin-right: .5rem; margin-bottom: .5rem; }',
	'.hub-tabs { display: flex; flex-wrap: wrap; gap: .4rem; margin: 1.2rem 0 0;',
	'  border-bottom: 1px solid rgba(128,128,128,.3); }',
	'.hub-tab { padding: .5rem 1.1rem; cursor: pointer; border: 1px solid transparent;',
	'  border-bottom: 0; border-radius: .35rem .35rem .0 .0; background: transparent;',
	'  color: inherit; font: inherit; margin-bottom: -1px; }',
	'.hub-tab.on { border-color: rgba(128,128,128,.3); background: rgba(128,128,128,.12);',
	'  font-weight: bold; }',
	'.hub-tab .hub-tag { font-size: .8em; opacity: .75; }',
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

function muted(text) {
	return E('span', { 'class': 'cbi-value-description' }, [ text ]);
}

function warn(text) {
	return E('span', { 'class': 'hub-warn' }, [ text ]);
}

function link(url, text) {
	if (!url)
		return muted('—');

	return E('a', { 'href': url, 'target': '_blank', 'rel': 'noopener' }, [ text || url ]);
}

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

function modeOf(list, id) {
	for (var i = 0; i < list.length; i++)
		if (list[i].id === id)
			return list[i];

	return list[0];
}

/* ---------------------------------------------------------------- 主视图 */

return view.extend({
	load: function() {
		/* 首屏只读 UCI。
		 *
		 * 之前这里还并了 1panel-ctl latest / disks，其中 latest 要 curl
		 * resource.fit2cloud.com 取远端版本号 —— 那一路走的是同步 exec，
		 * 网络一慢（路由器上还常是 IPv6 先试）页面就白屏十几秒。
		 * 现在所有 exec 都挪到 render 之后，页面先出来，数据再补。 */
		return Promise.all([
			uci.load('hub'),
			uci.load('1panel').catch(function() {}),
			uci.load('workbuddy2api').catch(function() {})
		]);
	},

	render: function() {
		var state = {
			svc: 'qb',
			mode: { qb: 'luci', ol: 'openlist2', pn: 'container', wb: 'python' },
			/* 用户自己点过方式页签就不再自动跳到已装那一栏 */
			pinned: { qb: false, ol: false, pn: false, wb: false },
			hub: {}, panel: {}, wb: {},
			latest: '',
			disks: [],
			disksWb: [],
			nets: [],
			sig: ''
		};

		var svcTabWrap = E('div', { 'class': 'hub-tabs' });
		var contentWrap = E('div');
		var out = E('pre', {
			'id': 'hub-out',
			'style': 'max-height:18rem;overflow:auto;white-space:pre-wrap;word-break:break-all;margin:1rem 0 0'
		}, [ _('（还没有执行任何操作）') ]);

		/* 输入框跨重绘复用：轮询刷新不该把正在填的内容清掉 */
		var inputs = { qb: {}, ol: {}, wb: {} };

		function once(store, key, factory) {
			if (!store[key])
				store[key] = factory();
			return store[key];
		}

		function bindOnce(el, ev, fn) {
			if (el.__hubBound)
				return;
			el.__hubBound = true;
			el.addEventListener(ev, fn);
		}

		function setOut(text) {
			out.textContent = text || _('（无输出）');
		}

		function run(tool, args, label) {
			setOut(_('正在执行：') + label + ' ...');

			return call(tool, args).then(function(res) {
				setOut('$ ' + tool.split('/').pop() + ' ' + args.join(' ') + '\n\n'
					+ (res.text || _('（无输出）')));

				if (res.code !== 0)
					ui.addNotification(null, E('p', {}, [
						label + _(' 失败（退出码 %s），看下方输出').format(res.code)
					]), 'danger');

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

		function textInput(value, placeholder, type) {
			return E('input', {
				'type': type || 'text',
				'class': 'cbi-input-text',
				'value': value === undefined || value === null ? '' : String(value),
				'placeholder': placeholder || ''
			});
		}

		function selectInput(options, cur) {
			return E('select', { 'class': 'cbi-input-select' }, options.map(function(o) {
				return E('option', { 'value': o.value, 'selected': cur === o.value ? '' : null },
					[ o.label ]);
			}));
		}

		function diskSelect(disks, suffix, target) {
			return E('select', {
				'class': 'cbi-input-select',
				'change': function(ev) {
					if (ev.target.value)
						target.value = ev.target.value;
				}
			}, [ E('option', { 'value': '' }, [ _('从检测到的磁盘里选…') ]) ].concat(
				(disks || []).map(function(d) {
					return E('option', { 'value': d.mount + '/' + suffix },
						[ d.mount + '/' + suffix + '  (' + _('剩余 %s').format(mb(d.free)) + ')' ]);
				})));
		}

		function statusCard(items) {
			var grid = E('div', { 'class': 'hub-grid' });

			items.forEach(function(it) {
				if (!it)
					return;

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

		/* 任务条：没有任务时返回空串。不能返回 null —— E() 会把 null 渲染成字面量 "null" */
		function taskBox(task) {
			var t = parseTask(task);

			if (!busy(t.phase) && t.phase !== 'error' && t.phase !== 'done')
				return '';

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
			return E('div', { 'class': 'hub-alert' + (cls ? ' ' + cls : '') }, [ E('div', {}, [ text ]) ]);
		}

		function openAnchor(text, host, port) {
			return E('a', {
				'class': 'btn cbi-button cbi-button-action',
				'href': 'http://' + (host || window.location.hostname) + ':' + port,
				'target': '_blank',
				'rel': 'noopener',
				'style': 'margin-right:.5rem;margin-bottom:.5rem'
			}, [ text ]);
		}

		function modeTabs(list, cur, onPick, tagOf) {
			var wrap = E('div', { 'class': 'hub-tabs' });

			list.forEach(function(m) {
				var on = m.id === cur;
				var tag = tagOf ? tagOf(m) : '';

				wrap.appendChild(E('button', {
					'class': 'hub-tab' + (on ? ' on' : ''),
					'click': function(ev) {
						ev.preventDefault();
						onPick(m.id);
					}
				}, [ m.title, tag ? E('span', { 'class': 'hub-tag' }, [ ' ' + tag ]) : '' ]));
			});

			return wrap;
		}

		function passwordRow(label, input, onSet, hint) {
			var btn = button(_('设置'), function() {
				if (!input.value) {
					ui.addNotification(null, E('p', {}, [ _('先填一个密码') ]), 'warning');
					return;
				}

				btn.disabled = true;

				return Promise.resolve(onSet(input.value)).then(function() {
					input.value = '';
					btn.disabled = false;
				}, function() {
					btn.disabled = false;
				});
			});

			/* .hub-form 里的 input 是 width:100%，和按钮并排时会把按钮挤到
			   只剩一个字宽（「设」换行成「置」）。所以给输入框留弹性的份额，
			   按钮自己不许被压缩。 */
			btn.style.whiteSpace = 'nowrap';
			btn.style.flex = '0 0 auto';

			return [
				E('label', {}, [ label ]),
				E('div', {}, [
					E('div', { 'style': 'display:flex;gap:.5rem;align-items:center' }, [
						E('div', { 'style': 'flex:1 1 auto;min-width:0' }, [ input ]),
						btn
					]),
					muted(' ' + hint)
				])
			];
		}

		/* ================================================================ qBittorrent */

		function qbInstalled(id, st) {
			if (id === 'luci')
				return st.qb_native === 'std';
			if (id === 'luci-ee')
				return st.qb_native === 'ee';
			return (st.qb_docker_variant || '') === id;
		}

		function qbHead(st) {
			var running = flag(st.qb_running);
			/* 显示实际在听的端口：conf 里的 WebUI\Port 才是事实，
			   hub 里配的只是「下次启动写进去的目标值」 */
			var port = st.qb_live_port || st.qb_port || '8090';
			var cfgPort = st.qb_port || '';
			var drift = cfgPort && String(port) !== String(cfgPort);
			var btPort = st.qb_live_bt_port || st.qb_bt_port || '21142';
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
				running ? openAnchor(_('打开 WebUI'), st.lanip, hostPort) : ''
			]) ]);

			items.push([ _('运行方式'), E('span', {}, [
				E('code', {}, [ modeOf(QB_MODES, st.qb_variant || 'luci').title ]),
				muted('  ' + _('原生：') + (kind === 'ee' ? _('增强版')
					: kind === 'std' ? _('官方版') : _('未装'))),
				st.qb_ct ? muted(' · ' + _('容器 ') + st.qb_ct) : ''
			]) ]);

			items.push([ _('监听端口'), E('span', {}, [
				net === 'bridge'
					? E('span', {}, [ _('宿主机 '), String(hostPort), ' → ', _('容器 '), String(port) ])
					: String(port),
				' ',
				flag(st.qb_port_busy) ? E('span', { 'class': 'label success' }, [ _('已监听') ])
					: muted(_('未监听')),
				drift ? E('span', {}, [
					muted('  ' + _('设置里填的是 ') + cfgPort + _('，qB 自己在听 ') + port
						+ _('（多半是在 qB 的 WebUI 里改过）。')),
					button(_('以 %s 为准').format(port), function() {
						return run(HUB, [ 'setport', String(port), String(btPort) ],
							_('把端口存为 %s').format(port)).then(function() {
							return refresh(true);
						});
					})
				]) : ''
			]) ]);

			items.push([ _('BT 监听端口'), E('span', {}, [ String(btPort) ]) ]);

			items.push([ _('数据目录'), E('span', {}, [
				E('code', {}, [ st.qb_datadir || '—' ]),
				flag(st.qb_datalink)
					? muted('  ' + _('原生版启动前从这里复制、停止后写回，与容器版共用一份'))
					: muted('  ' + _('未同步（数据还在 /etc 上）'))
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
				items.push(alertBox(_('原生版和容器版同时存在。两者共用同一个端口，同一时刻只能跑一个 —— 在对应页签里卸载另一个。')));

			if (flag(st.docker) && !flag(st.dockerroot_ok))
				items.push(alertBox(_('Docker 数据目录在 ') + (st.dockerroot || 'overlay')
					+ _('，镜像会吃 overlay 空间，刷机后还会一起没掉。改到 /mnt 后容器版才能跨刷机保留。')));

			items.push(taskBox(st.task));

			return statusCard(items);
		}

		/* 通用设置：端口、下载目录、数据目录、密码 —— 与原来两个页面一样常驻 */
		function qbShared(st) {
			var sec = 'qbittorrent';
			var running = flag(st.qb_running);

			var fPort = once(inputs.qb, 'port', function() {
				return textInput(st.qb_live_port || st.qb_port || '8090', '8090');
			});
			bindOnce(fPort, 'change', function() {
				var v = fPort.value.trim() || '8090';
				var bt = (fBt.value || '').trim() || st.qb_live_bt_port || st.qb_bt_port || '21142';

				/* 走 setport：UCI 和 qBittorrent.conf 一起写。
				   只改 UCI 的话服务没在跑时 conf 还是旧值，页面又会显示回旧端口。 */
				run(HUB, [ 'setport', v, String(bt) ], _('设置 WebUI 端口')).then(function() {
					return running ? run(HUB, [ 'restart', 'qbittorrent' ], _('按新端口重启')) : null;
				});
			});

			var fBt = once(inputs.qb, 'bt', function() {
				return textInput(st.qb_live_bt_port || st.qb_bt_port || '21142', '21142');
			});
			bindOnce(fBt, 'change', function() {
				var v = fBt.value.trim() || '21142';
				var web = (fPort.value || '').trim() || st.qb_live_port || st.qb_port || '8090';

				run(HUB, [ 'setport', String(web), v ], _('设置 BT 监听端口')).then(function() {
					return running ? run(HUB, [ 'restart', 'qbittorrent' ], _('按新端口重启')) : null;
				});
			});

			var fDl = once(inputs.qb, 'dl', function() {
				return textInput(st.qb_downloads || '/mnt/sda1/movie', '/mnt/sda1/movie');
			});
			bindOnce(fDl, 'change', function() {
				saveCfg(sec, { downloads: fDl.value.trim() });
			});

			var fDir = once(inputs.qb, 'dir', function() {
				return textInput(st.qb_datadir || '', '/mnt/sda1/Configs/qbittorrent');
			});
			bindOnce(fDir, 'change', function() {
				saveCfg(sec, { datadir: fDir.value.trim() }).then(function() {
					return running ? run(HUB, [ 'restart', 'qbittorrent' ], _('按新数据目录迁移并重启')) : null;
				});
			});

			var fPass = once(inputs.qb, 'pass', function() {
				return textInput('', _('新密码，留空不改'), 'password');
			});

			var rows = [
				E('label', {}, [ _('WebUI 端口') ]),
				E('div', {}, [ fPort, muted(' ' + _('默认 8090，别用 8080（Nikki 占着）。改完自动重启。')) ]),

				E('label', {}, [ _('BT 监听端口') ]),
				E('div', {}, [ fBt, muted(' ' + _('需要在防火墙或端口映射里放行 TCP + UDP。')) ]),

				E('label', {}, [ _('下载目录') ]),
				E('div', {}, [ fDl, muted(' ' + _('容器版里映射为 /downloads。目录不存在会自动创建。')) ]),

				E('label', {}, [ _('数据目录') ]),
				E('div', {}, [
					diskSelect(state.disks, 'Configs/qbittorrent', fDir),
					E('div', { 'style': 'margin:.35rem 0' }, [ fDir ]),
					muted(_('配置、种子、做种记录都放这里。改路径后下次启动会把原目录内容迁过去、'
						+ '再把 /etc/qBittorrent 里的内容换到新位置（启动时复制过去），数据不会丢。'))
				])
			].concat(passwordRow(_('WebUI 密码'), fPass,
				function(v) { return setPass('qbittorrent', v, _('设置 qB 密码')); },
				_('用户名固定 admin。做法是先把 127.0.0.1 加进免密白名单、再由本机调 qB 的 API，'
					+ '忘了密码时从路由器上仍能改回来，LAN 访问照旧要密码。')));

			return E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('通用设置') ]),
				E('div', { 'class': 'cbi-map-descr' }, [
					_('四种运行方式共用这一份端口、数据目录与密码，切换时不用重填。'),
					E('br'),
					_('数据目录在 /mnt 上，刷机不会丢；原生版的程序在 overlay 上，刷完点一次安装即可恢复。')
				]),
				E('div', { 'class': 'hub-form', 'style': 'margin-top:1rem' }, rows)
			]);
		}

		function qbPane(st, mode) {
			var v = mode.id;
			var inFlight = busy(parseTask(st.task).phase);
			var running = flag(st.qb_running);
			var installed = qbInstalled(v, st);
			var isDocker = v === 'docker' || v === 'docker-ee';

			var body = [
				E('h3', {}, [ mode.title ]),
				E('div', { 'class': 'cbi-map-descr' }, [ mode.how, E('br') ].concat(mode.notes))
			];

			/* 容器版固定 host：BT 要接大量入站连接，bridge 走 NAT 还得给 BT 端口
			   单独做映射，出问题也难查。不给选项，省得选错了再来找原因。 */
			if (isDocker) {
				body.push(E('div', { 'class': 'hub-form', 'style': 'margin-top:1rem' }, [
					E('label', {}, [ _('容器网络') ]),
					E('div', {}, [
						E('code', {}, [ 'host' ]),
						muted('  ' + _('固定用 host，容器内端口就是宿主机端口，和上面的通用设置一致。'
							+ 'BT 需要直接的入站连接，不做 NAT 映射。'))
					])
				]));
			}

			var ops = [];

			if (!installed) {
				ops.push(button(_('安装 %s').format(mode.title), function() {
					return run(HUB, [ 'install', 'qbittorrent', v ], _('安装 qBittorrent'));
				}, { primary: true, disabled: inFlight }));
			}
			else {
				ops.push(button(_('启动'), function() {
					return run(HUB, [ 'start', 'qbittorrent' ], _('启动'));
				}, { primary: true, disabled: inFlight || running }));
				ops.push(button(_('停止'), function() {
					return run(HUB, [ 'stop', 'qbittorrent' ], _('停止'));
				}, { disabled: inFlight || !running }));
				ops.push(button(_('重启'), function() {
					return run(HUB, [ 'restart', 'qbittorrent' ], _('重启'));
				}, { disabled: inFlight }));
				ops.push(button(_('查看日志'), function() {
					return run(HUB, [ 'logs', 'qbittorrent', '60' ], _('最近日志'));
				}));
				ops.push(button(_('卸载'), function() {
					return run(HUB, [ 'remove', 'qbittorrent' ], _('卸载 qBittorrent'));
				}, {
					danger: true,
					disabled: inFlight,
					confirm: _('会停掉并删除 qBittorrent 的程序与容器，数据目录保留。继续？')
				}));
			}

			if (installed && running)
				ops.push(openAnchor(_('打开 WebUI'), st.lanip,
					(st.qb_network || 'host') === 'bridge'
						? (st.qb_host_port || st.qb_live_port || st.qb_port)
						: (st.qb_live_port || st.qb_port)));

			body.push(E('div', { 'class': 'hub-actions', 'style': 'margin-top:1rem' }, ops));
			body.push(taskBox(st.task));

			return E('div', { 'class': 'cbi-section' }, body);
		}

		function qbView() {
			var st = state.hub;
			var frag = E('div');

			frag.appendChild(qbHead(st));
			frag.appendChild(qbShared(st));
			frag.appendChild(modeTabs(QB_MODES, state.mode.qb, function(id) {
				state.mode.qb = id;
				state.pinned.qb = true;
				state.sig = '';
				drawAll(true);
			}, function(m) {
				return qbInstalled(m.id, st) ? _('（已装）') : '';
			}));
			frag.appendChild(E('div', {}, [ qbPane(st, modeOf(QB_MODES, state.mode.qb)) ]));

			return frag;
		}

		/* ================================================================ OpenList */

		function olInstalled(id, st) {
			if (id === 'docker')
				return !!st.ol_ct;
			return st.ol_native === id;
		}

		function olHead(st) {
			var running = flag(st.ol_running);
			var port = st.ol_port || '5244';
			var net = st.ol_network || 'host';
			var hostPort = net === 'bridge' ? (st.ol_host_port || port) : port;
			var items = [];

			items.push([ _('状态'), E('div', { 'class': 'hub-head' }, [
				E('button', {
					'class': 'btn cbi-button ' + (running ? 'cbi-button-success' : 'cbi-button-negative'),
					'disabled': 'disabled',
					'style': 'cursor:default;min-width:13rem;opacity:1'
				}, [ running ? _('OpenList 正在运行') : _('OpenList 未运行') ]),
				running ? openAnchor(_('打开面板'), st.lanip, hostPort) : ''
			]) ]);

			items.push([ _('运行方式'), E('span', {}, [
				E('code', {}, [ modeOf(OL_MODES, st.ol_variant || 'openlist2').title ]),
				muted('  ' + _('原生：') + (st.ol_native === 'openlist2' ? 'openlist2'
					: st.ol_native === 'feeds' ? _('feeds 版') : _('未装'))),
				st.ol_ct ? muted(' · ' + _('容器 ') + st.ol_ct) : ''
			]) ]);

			items.push([ _('监听端口'), E('span', {}, [
				net === 'bridge'
					? E('span', {}, [ _('宿主机 '), String(hostPort), ' → ', _('容器 5244') ])
					: String(port),
				' ',
				flag(st.ol_port_busy) ? E('span', { 'class': 'label success' }, [ _('已监听') ])
					: muted(_('未监听'))
			]) ]);

			items.push([ _('数据目录'), E('span', {}, [
				E('code', {}, [ st.ol_datadir || '—' ]),
				flag(st.ol_datalink)
					? muted('  ' + _('原生版启动前从这里复制、停止后写回，三种方式共用一份'))
					: muted('  ' + _('未同步（数据还在 /etc 上）'))
			]) ]);

			items.push([ _('数据盘剩余'), mb(st.ol_config_free_kb || st.data_free_kb) ]);
			items.push([ _('overlay 剩余'), mb(st.overlay_free_kb) ]);

			if (flag(st.ol_conflict))
				items.push(alertBox(_('原生版和容器版同时存在，共用同一个端口，同一时刻只能跑一个。')));

			if (flag(st.docker) && !flag(st.dockerroot_ok))
				items.push(alertBox(_('Docker 数据目录在 ') + (st.dockerroot || 'overlay')
					+ _('，镜像会吃 overlay 空间，刷机后还会一起没掉。')));

			items.push(taskBox(st.task));

			return statusCard(items);
		}

		function olShared(st) {
			var sec = 'openlist';
			var running = flag(st.ol_running);

			var fPort = once(inputs.ol, 'port', function() {
				return textInput(st.ol_port || '5244', '5244');
			});
			bindOnce(fPort, 'change', function() {
				saveCfg(sec, { port: fPort.value.trim() || '5244' }).then(function() {
					return running ? run(HUB, [ 'restart', 'openlist' ], _('按新端口重启')) : null;
				});
			});

			var fDir = once(inputs.ol, 'dir', function() {
				return textInput(st.ol_datadir || '', '/mnt/sda1/Configs/openlist');
			});
			bindOnce(fDir, 'change', function() {
				saveCfg(sec, { datadir: fDir.value.trim() }).then(function() {
					return running ? run(HUB, [ 'restart', 'openlist' ], _('按新数据目录迁移并重启')) : null;
				});
			});

			var fPass = once(inputs.ol, 'pass', function() {
				return textInput('', _('新密码，留空不改'), 'password');
			});

			var rows = [
				E('label', {}, [ _('端口') ]),
				E('div', {}, [ fPort, muted(' ' + _('原生版会同步到 openlist2 / openlist 自己的 UCI。改完自动重启。')) ]),

				E('label', {}, [ _('数据目录') ]),
				E('div', {}, [
					diskSelect(state.disks, 'Configs/openlist', fDir),
					E('div', { 'style': 'margin:.35rem 0' }, [ fDir ]),
					muted(_('config.json 与 data.db 都在这里。/etc/openlist2 与 /etc/openlist 启动时从这里复制，'
						+ '容器版挂的也是这里。改路径后启动时自动迁移，数据不会丢。'))
				])
			].concat(passwordRow(_('管理员密码'), fPass,
				function(v) { return setPass('openlist', v, _('设置 OpenList 密码')); },
				_('对应面板的 admin 账号，直接写进 data.db，不用重启。容器版通过 docker exec 调用。')));

			return E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('通用设置') ]),
				E('div', { 'class': 'cbi-map-descr' }, [
					_('三种运行方式共用这一份端口、数据目录与管理员密码。'),
					E('br'),
					_('数据目录在 /mnt 上，刷机不会丢；原生版的程序在 overlay 上，刷完点一次安装即可恢复。')
				]),
				E('div', { 'class': 'hub-form', 'style': 'margin-top:1rem' }, rows)
			]);
		}

		function olPane(st, mode) {
			var v = mode.id;
			var inFlight = busy(parseTask(st.task).phase);
			var running = flag(st.ol_running);
			var installed = olInstalled(v, st);

			var body = [
				E('h3', {}, [ mode.title ]),
				E('div', { 'class': 'cbi-map-descr' }, [ mode.how, E('br') ].concat(mode.notes))
			];

			if (v === 'docker') {
				var net = st.ol_network || 'host';

				/* host 之外还有 docker 里现成的桥接网络可选（macvlan/自定义 bridge），
				   列表是 hub-ctl networks 查出来的，跟磁盘候选一样是首屏之后异步补的 */
				var fNet = once(inputs.ol, 'net', function() {
					var opts = [
						{ value: 'host', label: _('host（推荐，端口就是上面的端口）') },
						{ value: 'bridge', label: _('bridge（默认网桥，需要端口映射）') }
					];

					(state.nets || []).forEach(function(n) {
						opts.push({ value: n, label: n });
					});

					/* 之前选的自定义网络这会儿可能已经被删了，补一条免得下拉空白 */
					if (net !== 'host' && net !== 'bridge' &&
						(state.nets || []).indexOf(net) < 0)
						opts.push({ value: net, label: net + _('（已不存在）') });

					return selectInput(opts, net);
				});
				bindOnce(fNet, 'change', function() {
					saveCfg('openlist', { network: fNet.value }).then(function() {
						return refresh(true);
					});
				});

				var fHostPort = once(inputs.ol, 'hostport', function() {
					return textInput(st.ol_host_port || st.ol_port || '5244', '5244');
				});
				bindOnce(fHostPort, 'change', function() {
					saveCfg('openlist', { host_port: fHostPort.value.trim() || st.ol_port || '5244' })
						.then(function() {
							return running ? run(HUB, [ 'restart', 'openlist' ], _('按新映射端口重启')) : null;
						});
				});

				var netRows = [
					E('label', {}, [ _('容器网络') ]),
					E('div', {}, [ fNet, muted(' ' + _('host 下容器固定监听 5244，宿主机也就只能是 5244；'
						+ '要换端口就选 bridge 或自己的桥接网络，再填映射端口。')) ])
				];

				if (net !== 'host')
					netRows = netRows.concat([
						E('label', {}, [ _('映射端口') ]),
						E('div', {}, [ fHostPort,
							muted(_(' 宿主机侧端口 → 容器内 5244。容器里固定监听 5244，这里只改对外映射。')) ])
					]);

				body.push(E('div', { 'class': 'hub-form', 'style': 'margin-top:1rem' }, netRows));
			}

			var ops = [];

			if (!installed) {
				ops.push(button(_('安装 %s').format(mode.title), function() {
					return run(HUB, [ 'install', 'openlist', v ], _('安装 OpenList'));
				}, { primary: true, disabled: inFlight }));
			}
			else {
				ops.push(button(_('启动'), function() {
					return run(HUB, [ 'start', 'openlist' ], _('启动'));
				}, { primary: true, disabled: inFlight || running }));
				ops.push(button(_('停止'), function() {
					return run(HUB, [ 'stop', 'openlist' ], _('停止'));
				}, { disabled: inFlight || !running }));
				ops.push(button(_('重启'), function() {
					return run(HUB, [ 'restart', 'openlist' ], _('重启'));
				}, { disabled: inFlight }));
				ops.push(button(_('查看日志'), function() {
					return run(HUB, [ 'logs', 'openlist', '60' ], _('最近日志'));
				}));
				ops.push(button(_('卸载'), function() {
					return run(HUB, [ 'remove', 'openlist' ], _('卸载 OpenList'));
				}, {
					danger: true,
					disabled: inFlight,
					confirm: _('会停掉并删除 OpenList 的程序与容器，数据目录保留。继续？')
				}));
			}

			if (installed && running)
				ops.push(openAnchor(_('打开面板'), st.lanip,
					(st.ol_network || 'host') !== 'host' ? (st.ol_host_port || st.ol_port) : st.ol_port));

			body.push(E('div', { 'class': 'hub-actions', 'style': 'margin-top:1rem' }, ops));
			body.push(taskBox(st.task));

			return E('div', { 'class': 'cbi-section' }, body);
		}

		function olView() {
			var st = state.hub;
			var frag = E('div');

			frag.appendChild(olHead(st));
			frag.appendChild(olShared(st));
			frag.appendChild(modeTabs(OL_MODES, state.mode.ol, function(id) {
				state.mode.ol = id;
				state.pinned.ol = true;
				state.sig = '';
				drawAll(true);
			}, function(m) {
				return olInstalled(m.id, st) ? _('（已装）') : '';
			}));
			frag.appendChild(E('div', {}, [ olPane(st, modeOf(OL_MODES, state.mode.ol)) ]));

			return frag;
		}

		/* ================================================================ 1Panel */

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

			items.push(taskBox(st.task));

			return statusCard(items);
		}

		function pnPane(st, modeId) {
			var isC = modeId === 'container';
			var inFlight = busy(parseTask(st.task).phase);
			var present = flag(isC ? st.container_present : st.native_present);
			var other = flag(isC ? st.native_present : st.container_present);

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

				ops.push(button(_('检查更新'), function() { return ctl([ 'latest' ], _('检查更新')); }));
				ops.push(button(_('查看日志'), function() {
					return ctl(isC ? [ 'container', 'logs' ] : [ 'logs' ], _('1Panel 日志'));
				}));

				if (running && st.address)
					ops.push(E('a', {
						'class': 'btn cbi-button cbi-button-action',
						'href': st.address, 'target': '_blank', 'rel': 'noopener',
						'style': 'margin-right:.5rem;margin-bottom:.5rem'
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
					E('h3', {}, [ isC ? _('容器版 1Panel') : _('本地版 1Panel') ]),
					E('div', { 'class': 'cbi-map-descr' }, [
						isC
							? _('用 docker compose 跑 1Panel v2，数据挂在 /mnt 下，容器里看到的路径和宿主机一致。')
							: _('官方 install.sh 铺二进制，procd 托管 1panel-core 与 1panel-agent，不走容器。')
					]),
					E('div', { 'style': 'margin-top:1rem' }, ops),
					taskBox(st.task)
				]);
			}

			var fPort = textInput((isC ? st.container_port : st.native_port) || '10086', '10086');
			var fUser = textInput((isC ? st.container_username : st.native_username) || '1panel', '1panel');
			var fPass = textInput('', _('至少 8 位'), 'password');
			var fEnt = textInput('', _('例如 panel-8x3k，别用 entrance'));
			var fDir = textInput((isC ? st.container_datadir : st.native_datadir) || '/mnt/sda1/Configs/1panel',
				'/mnt/sda1/Configs/1panel');
			var fImg = textInput(st.container_image || 'moelin/1panel:v2', 'moelin/1panel:v2');

			var chkRoot = E('input', { 'type': 'checkbox' });

			var blockedNote = other
				? alertBox(isC ? _('已安装本地版 1Panel，不能再装容器版')
					: _('已安装容器版 1Panel，不能再装本地版'))
				: null;

			var installBtn = button(inFlight ? _('安装进行中…') : _('开始安装'), function() {
				if (!fPass.value || fPass.value.length < 8) {
					ui.addNotification(null, E('p', {}, [ _('密码至少 8 位') ]), 'warning');
					return;
				}

				if (!/^[A-Za-z0-9._-]+$/.test(fEnt.value)) {
					ui.addNotification(null, E('p', {}, [
						_('入口路径只能用字母、数字、点、下划线和连字符')
					]), 'warning');
					return;
				}

				if (fDir.value.indexOf('/mnt/') !== 0) {
					ui.addNotification(null, E('p', {}, [
						_('数据目录必须在 /mnt 下：面板的数据库、备份、应用都写这里')
					]), 'warning');
					return;
				}

				return ctl(isC
					? [ 'container', 'install', fPort.value, fUser.value, fPass.value,
						fEnt.value, fDir.value, chkRoot.checked ? '1' : '0', fImg.value ]
					: [ 'install', fPort.value, fUser.value, fPass.value, fEnt.value, fDir.value ],
					_('安装 1Panel'));
			}, { primary: true, disabled: inFlight || other });

			var formRows = [
				E('label', {}, [ _('监听端口') ]), fPort,
				E('label', {}, [ _('登录账号') ]), fUser,
				E('label', {}, [ _('登录密码') ]), fPass,
				E('label', {}, [ _('入口路径') ]), fEnt,
				E('label', {}, [ _('数据目录') ]),
				E('div', {}, [
					diskSelect(state.disks, 'Configs/1panel', fDir),
					E('div', { 'style': 'margin:.35rem 0' }, [ fDir ]),
					muted(' ' + _('必须在 /mnt 下；面板的数据库、备份、应用都写这里'))
				])
			];

			if (isC)
				formRows = formRows.concat([
					E('label', {}, [ _('镜像') ]), fImg,
					E('label', {}, [ _('挂载 root 路径') ]),
					E('div', {}, [
						E('label', {}, [ chkRoot, ' ', _('把宿主机根目录挂到容器的 /ahost') ]),
						E('div', {}, [ muted(_('面板里要浏览整机文件、或装需要碰 /etc 的应用时才勾。')) ])
					])
				]);

			var body = [
				E('h3', {}, [ isC ? _('安装容器版 1Panel') : _('安装本地版 1Panel') ]),
				E('div', { 'class': 'cbi-map-descr' }, [
					isC
						? _('从 Docker Hub 拉官方镜像（moelin/1panel），用 docker compose 起容器。')
						: _('从官方源拉安装包，用官方 install.sh 安装，OpenWrt 上用 procd 托管。'),
					E('br'),
					_('端口、账号、密码、入口都在首次初始化时写进面板；数据目录必须在 /mnt 下。')
				])
			];

			if (blockedNote)
				body.push(blockedNote);

			if (isC && !flag(st.docker))
				body.push(alertBox(_('Docker 没在运行，容器版装不了。先确认 docker 服务和 socket 正常。'), 'err'));

			body.push(E('div', { 'class': 'hub-form', 'style': 'margin-top:1rem' }, formRows));
			body.push(E('div', { 'class': 'hub-actions', 'style': 'margin-top:1rem' }, [ installBtn ]));
			body.push(taskBox(st.task));

			return E('div', { 'class': 'cbi-section' }, body);
		}

		/* 已装后的「通用设置」。1Panel 的端口、账号、入口都存在面板自己的
		 * 数据库里（compose 里的环境变量只在首次初始化时生效），所以这里
		 * 显示的是从面板实时读到的值，改要去面板里改 —— 给个能填的输入框
		 * 反而会让人以为改了有效。未安装时安装表单里本来就是这些字段，
		 * 这里返回空，避免一屏两套同样的表。 */
		function pnShared(st) {
			var kind = st.kind || 'none';

			if (kind === 'none')
				return null;

			return E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('通用设置') ]),
				E('div', { 'class': 'cbi-map-descr' }, [
					_('下面是从面板数据库里读到的当前值（不是安装时填的那份）。'),
					E('br'),
					_('端口、登录账号、入口路径在面板的「面板设置」里改，改完这里会跟着变；'
						+ '数据目录要动的话得迁移整个目录，风险大，本页只展示。')
				]),
				E('div', { 'class': 'hub-form', 'style': 'margin-top:1rem' }, [
					E('label', {}, [ _('监听端口') ]),
					E('div', {}, [ E('code', {}, [ st.port || '—' ]),
						flag(st.listening) ? E('span', { 'class': 'label success' }, [ _('已监听') ])
							: muted(' ' + _('未监听')) ]),

					E('label', {}, [ _('登录账号') ]),
					E('div', {}, [ E('code', {}, [ st.username || '—' ]) ]),

					E('label', {}, [ _('入口路径') ]),
					E('div', {}, [ st.entrance ? E('code', {}, [ st.entrance ]) : muted(_('未设置（直接用 http://IP:端口 访问）')) ]),

					E('label', {}, [ _('访问地址') ]),
					E('div', {}, [ link(st.address) ]),

					E('label', {}, [ _('数据目录') ]),
					E('div', {}, [ E('code', {}, [ st.datadir || '—' ]) ]),

					E('label', {}, [ _('镜像 / 程序') ]),
					E('div', {}, [ kind === 'container'
						? E('code', {}, [ st.container_image || '—' ])
						: E('code', {}, [ '/usr/local/bin/1panel（install.sh 安装）' ]) ])
				])
			]);
		}

		function pnView() {
			var st = state.panel;
			var frag = E('div');

			frag.appendChild(pnHead(st));

			var shared = pnShared(st);

			if (shared)
				frag.appendChild(shared);

			frag.appendChild(modeTabs(PN_MODES, state.mode.pn, function(id) {
				state.mode.pn = id;
				state.pinned.pn = true;
				state.sig = '';
				drawAll(true);
			}, function(m) {
				return flag(m.id === 'container' ? st.container_present : st.native_present)
					? _('（已装）') : '';
			}));
			frag.appendChild(E('div', {}, [ pnPane(st, state.mode.pn) ]));

			return frag;
		}

		/* ================================================================ WorkBuddy2API */

		function wbSfx(id) { return String(id).replace(/-/g, '_'); }

		function wbF(st, id, name) { return st[wbSfx(id) + '_' + name]; }

		function wbPresent(st, id) { return flag(wbF(st, id, 'present')); }

		function wbRunningOf(st, id) { return flag(wbF(st, id, 'running')); }

		function wbVersion(st, id) { return wbF(st, id, 'version') || ''; }

		function wbLatest(st, id) {
			return String(id).indexOf('python') === 0 ? (st.latest_python || '') : (st.latest_rust || '');
		}

		function wbHead(st) {
			var kind = st.kind || 'none';
			var running = flag(st.running) && kind !== 'none';
			var items = [];
			var label = kind === 'none'
				? _('WorkBuddy2API 未安装')
				: (running ? _('WorkBuddy2API 正在运行（%s）') : _('WorkBuddy2API 已停止（%s）'))
					.format(modeOf(WB_MODES, kind).title);

			items.push([ _('状态'), E('div', { 'class': 'hub-head' }, [
				E('button', {
					'class': 'btn cbi-button ' + (running ? 'cbi-button-success' : 'cbi-button-negative'),
					'disabled': 'disabled',
					'style': 'cursor:default;min-width:16rem;opacity:1'
				}, [ label ]),
				running && st.address ? E('a', {
					'class': 'btn cbi-button cbi-button-action',
					'href': st.address, 'target': '_blank', 'rel': 'noopener'
				}, [ _('打开看板') ]) : ''
			]) ]);

			if (kind !== 'none') {
				var cur = st.version || '';
				var newv = wbLatest(st, kind);
				var cell = [ E('code', {}, [ cur ? 'v' + vnum(cur) : '—' ]) ];

				if (newv && cur && vnum(newv) !== vnum(cur))
					cell.push(E('span', { 'class': 'hub-up', 'style': 'margin-left:.6rem' },
						[ _('有新版本 %s').format(newv) ]));
				else if (newv && cur)
					cell.push(muted(' ' + _('（已是最新）')));
				else
					cell.push(muted(' ' + _('（点下面的「检查更新」查上游）')));

				items.push([ _('已装版本'), cell ]);
				items.push([ _('访问地址'), link(st.address) ]);
				items.push([ _('API 地址'), link(st.address ? st.address + '/v1' : '') ]);

				if (running && !flag(st.listening))
					items.push([ _('端口'), [ st.port, warn(_(' 没有监听')) ] ]);
			}
			else {
				items.push([ _('已装版本'), muted(_('还没装')) ]);
				items.push([ _('访问地址'), muted(_('装好后 http://<路由器IP>:<端口>')) ]);
			}

			items.push([ _('端口'), st.port || '—' ]);
			items.push([ _('数据目录'), E('code', {}, [ st.datadir || '—' ]) ]);
			items.push([ _('账号数'), [
				E('code', {}, [ String(int(st.accounts)) ]),
				muted(' ' + _('个 JSON（在 accounts/ 下，四版共用）'))
			] ]);
			items.push([ _('用量体积'), mb(st.usagesize_kb) ]);
			items.push([ _('数据盘剩余'), mb(st.data_free_kb) ]);
			items.push([ _('overlay 剩余'), mb(st.overlay_free_kb) ]);

			if (flag(st.docker))
				items.push([ _('Docker 剩余'), mb(st.docker_free_kb) ]);

			items.push(taskBox(st.task));

			return statusCard(items);
		}

		/* 四个版本共用端口与数据目录，和原页面一样单独一栏；装完也保留 */
		function wbShared(st) {
			var fPort = once(inputs.wb, 'port', function() {
				return textInput(st.port || '8788', '8788');
			});
			var fDir = once(inputs.wb, 'dir', function() {
				return textInput(st.datadir || '/mnt/sda1/Configs/workbuddy2api',
					'/mnt/sda1/Configs/workbuddy2api');
			});

			return E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('通用设置') ]),
				E('div', { 'class': 'cbi-map-descr' }, [
					_('四个版本共用同一个数据目录和端口：accounts/ 里每个账号一个 JSON，usage/ 里是用量日志。'),
					E('br'),
					_('换实现只是换运行方式，账号和额度记录原地不动。'),
					_('这两项在安装时生效：已装的话改完先卸载再装，或直接点「重启」让配置重新生成。')
				]),
				E('div', { 'class': 'hub-form', 'style': 'margin-top:1rem' }, [
					E('label', {}, [ _('监听端口') ]), fPort,
					E('label', {}, [ _('数据目录') ]),
					E('div', {}, [
						diskSelect(state.disksWb, 'Configs/workbuddy2api', fDir),
						E('div', { 'style': 'margin:.35rem 0' }, [ fDir ]),
						muted(' ' + _('必须在 /mnt 下，账号凭据和用量都写这里'))
					])
				])
			]);
		}

		function wbOpsPane(st, mode) {
			var inFlight = busy(parseTask(st.task).phase);
			var running = wbRunningOf(st, mode.id);
			var cur = wbVersion(st, mode.id);
			var newv = wbLatest(st, mode.id);
			var canUpdate = newv && cur && vnum(newv) !== vnum(cur);
			var ops = [];

			function ctl(args, label) { return run(CTL_WB, args, label); }

			if (canUpdate)
				ops.push(button(_('更新到 %s').format(newv), function() {
					return ctl([ 'update', mode.id ], _('更新 %s').format(mode.title));
				}, { primary: true, disabled: inFlight }));

			ops.push(running
				? button(_('停止'), function() { return ctl([ 'stop', mode.id ], _('停止')); },
					{ disabled: inFlight })
				: button(_('启动'), function() { return ctl([ 'start', mode.id ], _('启动')); },
					{ primary: true, disabled: inFlight }));

			ops.push(button(_('重启'), function() { return ctl([ 'restart', mode.id ], _('重启')); },
				{ disabled: inFlight }));
			ops.push(button(_('检查更新'), function() { return ctl([ 'latest', 'all' ], _('检查更新')); }));
			ops.push(button(_('查看日志'), function() { return ctl([ 'logs', mode.id ], _('日志')); }));

			if (running && st.address)
				ops.push(E('a', {
					'class': 'btn cbi-button cbi-button-action',
					'href': st.address, 'target': '_blank', 'rel': 'noopener',
					'style': 'margin-right:.5rem;margin-bottom:.5rem'
				}, [ _('打开看板') ]));

			ops.push(button(_('卸载'), function() {
				return ctl([ 'remove', mode.id ], _('卸载'));
			}, {
				danger: true,
				disabled: inFlight,
				confirm: _('会停掉并删除 %s 的程序，数据目录里的账号和用量保留。继续？').format(mode.title)
			}));

			ops.push(button(_('卸载并删除数据'), function() {
				return ctl([ 'remove', mode.id, 'purge' ], _('卸载并删除数据'));
			}, {
				danger: true,
				disabled: inFlight,
				confirm: _('会把 %s 里的 accounts 和 usage 一起删掉，账号凭据全部丢失、不可恢复。继续？')
					.format(st.datadir || '')
			}));

			var info = [
				E('div', {}, [ _('实现'), ': ', mode.how ]),
				E('div', {}, [ _('版本'), ': ', E('code', {}, [ cur ? 'v' + vnum(cur) : '—' ]) ])
			];

			if (mode.id.indexOf('docker') > 0)
				info.push(E('div', {}, [ _('容器'), ': ', E('code', {}, [ 'wb-proxy' ]),
					muted(' ' + _('（host 网络，compose 文件在数据目录下）')) ]));
			else if (mode.id === 'rust')
				info.push(E('div', {}, [ _('程序'), ': ', E('code', {}, [ '/usr/bin/wb-backend' ]) ]));
			else
				info.push(E('div', {}, [ _('程序'), ': ', E('code', {}, [ '/usr/lib/workbuddy2api' ]),
					muted(' ' + _('（官方包，apk/opkg 管理）')) ]));

			return E('div', { 'class': 'cbi-section hub-actions' }, [
				E('h3', {}, [ mode.title ]),
				E('div', { 'class': 'cbi-map-descr' }, mode.notes),
				E('div', { 'style': 'margin-top:1rem' }, info),
				E('div', { 'style': 'margin-top:1rem' }, ops),
				taskBox(st.task)
			]);
		}

		function wbInstallPane(st, mode) {
			var inFlight = busy(parseTask(st.task).phase);
			var other = '';

			WB_MODES.forEach(function(m) {
				if (!other && m.id !== mode.id && wbPresent(st, m.id))
					other = m.id;
			});

			var blocked = !!other;
			var fTag = E('input', {
				'type': 'text', 'class': 'cbi-input-text', 'placeholder': mode.fieldHint
			});

			var installBtn = button(inFlight ? _('进行中…') : _('安装 %s').format(mode.title),
				function() {
					var fPort = inputs.wb.port;
					var fDir = inputs.wb.dir;

					if (fDir.value.indexOf('/mnt/') !== 0) {
						ui.addNotification(null, E('p', {}, [
							_('数据目录必须在 /mnt 下：账号凭据、用量日志、容器数据都写这里')
						]), 'warning');
						return;
					}

					if (!/^[0-9]+$/.test(fPort.value)) {
						ui.addNotification(null, E('p', {}, [ _('端口必须是数字') ]), 'warning');
						return;
					}

					return run(CTL_WB, [ 'install', mode.id, fPort.value, fDir.value, fTag.value ],
						_('安装 %s').format(mode.title));
				}, { primary: true, disabled: inFlight || blocked });

			var body = [
				E('h3', {}, [ mode.title ]),
				E('div', { 'class': 'cbi-map-descr' }, [ mode.how, E('br') ].concat(mode.notes))
			];

			if (blocked) {
				var om = modeOf(WB_MODES, other);

				body.push(alertBox(E('div', {}, [
					E('strong', {}, [ _('已经装了「%s」').format(om.title) ]),
					E('div', { 'style': 'margin-top:.3rem' }, [
						_('四选一：同一时刻只能跑一个实现，装新的之前请先到「%s」页签把它卸载。')
							.format(om.title)
					])
				])));
			}

			if (mode.id === 'python' && !flag(st.pkgpython))
				body.push(alertBox(_('系统里没有 python3：安装时会从软件源拉 python3 等依赖（约 15MB），'
					+ '需要联网和可用的 opkg/apk 源。')));

			body.push(E('div', { 'class': 'hub-form', 'style': 'margin-top:1rem' }, [
				E('label', {}, [ mode.fieldLabel ]), fTag,
				E('label', {}, [ _('装到哪里') ]),
				E('div', {}, [ muted(mode.id.indexOf('docker') > 0
					? _('容器 wb-proxy，镜像落在 docker 数据盘；账号与用量挂在上面那个数据目录。')
					: _('程序落在 overlay，数据在上面那个数据目录。')) ])
			]));

			body.push(E('div', { 'class': 'hub-actions', 'style': 'margin-top:1rem' }, [ installBtn ]));
			body.push(taskBox(st.task));

			return E('div', { 'class': 'cbi-section' }, body);
		}

		function wbView() {
			var st = state.wb;
			var frag = E('div');
			var mode = modeOf(WB_MODES, state.mode.wb);

			frag.appendChild(wbHead(st));
			frag.appendChild(wbShared(st));
			frag.appendChild(modeTabs(WB_MODES, state.mode.wb, function(id) {
				state.mode.wb = id;
				state.pinned.wb = true;
				state.sig = '';
				drawAll(true);
			}, function(m) {
				return wbPresent(st, m.id) ? _('（已装）') : '';
			}));
			frag.appendChild(E('div', {}, [
				wbPresent(st, mode.id) ? wbOpsPane(st, mode) : wbInstallPane(st, mode)
			]));

			return frag;
		}

		/* ================================================================ 组装 */

		function svcRunning(id) {
			switch (id) {
			case 'qb': return flag(state.hub.qb_running);
			case 'ol': return flag(state.hub.ol_running);
			case 'pn': return flag(state.panel.running);
			case 'wb': return flag(state.wb.running);
			default: return false;
			}
		}

		function drawSvcTabs() {
			clear(svcTabWrap);

			SVCS.forEach(function(s) {
				var on = state.svc === s.id;
				var tag = svcRunning(s.id) ? _('（运行中）') : '';

				svcTabWrap.appendChild(E('button', {
					'class': 'hub-tab' + (on ? ' on' : ''),
					'click': function(ev) {
						ev.preventDefault();
						state.svc = s.id;
						state.sig = '';
						drawAll(true);
					}
				}, [ s.title, tag ? E('span', { 'class': 'hub-tag' }, [ ' ' + tag ]) : '' ]));
			});
		}

		function signature() {
			var h = state.hub, p = state.panel, w = state.wb;

			return [
				state.svc, state.mode.qb, state.mode.ol, state.mode.pn, state.mode.wb,
				h.task, h.docker, h.dockerroot_ok, h.mnt,
				h.qb_variant, h.qb_running, h.qb_native, h.qb_ct, h.qb_docker_variant,
				h.qb_port, h.qb_live_port, h.qb_host_port, h.qb_port_busy, h.qb_network, h.qb_datalink,
				h.qb_bt_port, h.qb_live_bt_port,
				h.qb_datadir, h.qb_conflict,
				h.ol_variant, h.ol_running, h.ol_native, h.ol_ct, h.ol_port, h.ol_host_port,
				h.ol_port_busy, h.ol_network, h.ol_datalink, h.ol_datadir, h.ol_conflict,
				p.kind, p.task, p.running, p.version, p.latest,
				p.container_present, p.native_present, p.container_running, p.native_running,
				p.conflict, p.docker,
				w.kind, w.running, w.task, w.version, w.port, w.accounts, w.listening,
				w.python_present, w.python_docker_present, w.rust_present, w.rust_docker_present,
				w.python_version, w.python_docker_version, w.rust_version, w.rust_docker_version,
				state.latest
			].join('|');
		}

		function drawAll(force) {
			var sig = signature();

			/* 用户正在表单里打字时不能被轮询重画，只有状态真变了才重建 */
			if (!force && sig === state.sig)
				return;

			state.sig = sig;

			/* 已装的实现自动切到对应方式页签，用户手动点过就不再干预 */
			if (state.svc === 'qb' && !state.pinned.qb) {
				var qbInst = [ 'luci', 'luci-ee', 'docker', 'docker-ee' ].filter(function(id) {
					return qbInstalled(id, state.hub);
				});

				if (qbInst.length === 1)
					state.mode.qb = qbInst[0];
			}

			if (state.svc === 'ol' && !state.pinned.ol) {
				var olInst = [ 'openlist2', 'feeds', 'docker' ].filter(function(id) {
					return olInstalled(id, state.hub);
				});

				if (olInst.length === 1)
					state.mode.ol = olInst[0];
			}

			if (state.svc === 'wb' && !state.pinned.wb) {
				var kind = state.wb.kind;

				if (kind && kind !== 'none')
					state.mode.wb = kind;
			}

			drawSvcTabs();
			clear(contentWrap);

			switch (state.svc) {
			case 'qb': contentWrap.appendChild(qbView()); break;
			case 'ol': contentWrap.appendChild(olView()); break;
			case 'pn': contentWrap.appendChild(pnView()); break;
			case 'wb': contentWrap.appendChild(wbView()); break;
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

		/* 数据目录候选：只是 df，几百毫秒，但不能挡首屏 */
		function loadDisks() {
			return Promise.all([
				call(CTL_1P, [ 'disks' ]).catch(function() { return { text: '' }; }),
				call(CTL_WB, [ 'disks' ]).catch(function() { return { text: '' }; })
			]).then(function(res) {
				state.disks = parseDisks(res[0].text);
				state.disksWb = parseDisks(res[1].text);
				drawAll(true);
			});
		}

		/* docker 里的桥接网络：给 OpenList 容器版选网络用，同样异步补 */
		function loadNetworks() {
			return call(HUB, [ 'networks' ]).then(function(res) {
				var list = [];

				(res.text || '').split('\n').forEach(function(line) {
					var i = line.indexOf('=');

					if (i > 0 && line.substring(0, i).trim() === 'net')
						list.push(line.substring(i + 1).trim());
				});

				if (list.join('|') !== (state.nets || []).join('|')) {
					state.nets = list;
					drawAll(true);
				}
			}).catch(function() {});
		}

		/* 1Panel 远端最新版本要出网，慢到几秒都可能，单独跑、不 await */
		function loadLatest() {
			return call(CTL_1P, [ 'latest' ]).then(function(res) {
				var v = parseKV(res.text).latest || '';

				if (v && v !== state.latest) {
					state.latest = v;
					drawAll(false);
				}
			}).catch(function() {});
		}

		/* 先把页面骨架点出来，别让人对着空白等 status */
		contentWrap.appendChild(E('div', { 'class': 'cbi-section' }, [
			E('div', { 'class': 'cbi-map-descr' }, [ _('正在读取状态…') ])
		]));

		refresh(true);
		loadDisks();
		loadNetworks();
		loadLatest();

		/* 5 秒一轮：任务进度、端口映射这些要跟上，status 已经做过裁剪
		   （docker info 只问一次、1pctl 有 15 秒缓存），扛得住。 */
		poll.add(function() {
			return refresh(false);
		}, 5);

		return E('div', {}, [
			E('style', {}, [ CSS ]),
			E('h2', {}, [ _('服务合集') ]),
			E('div', { 'class': 'cbi-map-descr' }, [
				_('qBittorrent、OpenList、1Panel、WorkBuddy2API 收在一个页面里。'),
				E('br'),
				_('每个服务都是「状态 → 通用设置 → 方式页签 → 安装/操作」：'),
				_('qBittorrent 四种运行方式、OpenList 三种、1Panel 两种、WorkBuddy2API 四种，全部用页签切换。')
			]),
			svcTabWrap,
			contentWrap,
			out
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
