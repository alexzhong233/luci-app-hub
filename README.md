# luci-app-hub

把四个常用服务收进一个 LuCI 页面，页签切换。

| 页签 | 运行方式 |
|---|---|
| **qBittorrent** | 原生官方版 · 原生增强版（EE，反吸血） · 容器官方版 · 容器增强版 |
| **OpenList** | openlist2（sbwml，运行时下载预编译包） · feeds 官方版 · 容器版 |
| **1Panel** | 容器版 · 本地版 |
| **WorkBuddy2API** | 本地 Rust · 本地 Python · 容器 Rust · 容器 Python |

四个页签都是完整的安装 / 更新 / 启停 / 卸载 / 日志，不用再去别的页面。

版式沿用 `luci-app-1panel` 与 `luci-app-workbuddy2api` 原来那套。每个服务都是同一结构：

```
状态卡（两列 hub-grid）
通用设置（两列 hub-form：端口 / 数据目录 / 密码）
方式页签（hub-tabs，当前方式高亮，已装的打「（已装）」）
安装 / 操作区（未装是安装表单，已装是启动/停止/重启/日志/卸载）
输出（pre，命令原文与返回）
```

**运行方式一律用页签，不用下拉框**：qBittorrent 4 个、OpenList 3 个、1Panel 2 个、
WorkBuddy2API 4 个。通用设置常驻，装完也不消失，改端口、改数据目录随时可以。

用 CSS Grid 而不是 `<table>` / `cbi-value`，是因为 Argon、Aurora 这类主题对 `th`/`td` 和
`.cbi-value-title` 有高特异性的 `!important` 规则，会把表头和数据行拆成不同的盒模型，
HTML 表格在这种主题下必然错位。

## 为什么合并

qBittorrent 在 OpenWrt 上的原生包有个反复踩的坑：`/etc/init.d/qbittorrent` 每次
启动都 `sed -i` 把 UCI 里的 `http_port` 写进 `qBittorrent.conf`，而 qBittorrent 收到
SIGTERM 时又会把内存里的配置写回文件——两者次序不固定，改端口时好时坏。

容器版没有这个问题：配置在 volume 里，端口在 compose 里，跟 init 脚本无关。把四种
运行方式放在同一个页面并统一数据目录，切换时不用再记每种的路径和端口规则。

1Panel 和 WorkBuddy2API 的**管理逻辑**没有重写，`1panel-ctl` / `workbuddy2api-ctl`
原样放进同一个包、由新页面调用——它们已经跑稳，为了"合并"再动一遍只会引入风险。
页面这边只是把它们原本分散的操作重新排进同一个界面。

## 数据目录

按顺序取第一个可用的：

1. `hub.<服务名>.datadir`（UCI 里显式指定）
2. `/mnt/sda1/Configs/services/<服务名>`（`/mnt/sda1` 已挂载且可写时）
3. 该服务原生版的位置（`/etc/qBittorrent`、`/etc/openlist2`、`/etc/openlist`）

页面上**数据目录是可改的**（qBittorrent 与 OpenList 各一个输入框）：改成别的路径后点
「启动」或「安装」，ctl 会把原目录内容迁到新位置，再把 `/etc/...` 换成指向新位置的
符号链接——目录层级不变，所以读到的还是同一份 `qBittorrent.conf` / `data.db`。
迁移时**目标目录里已有的同名文件不覆盖**（以你指定的那份为准）。留空则回到上面第 2、3 条。

qBittorrent 的 `config` 子目录里是 `qBittorrent.conf` 和 `BT_backup`，后者装着种子
和做种记录，**切换运行方式或重装都不要删这个目录**。

## 安装

不重刷固件：

```sh
curl -fsSL https://raw.githubusercontent.com/alexzhong233/luci-app-hub/main/deploy.sh | sh
```

或走 jsDelivr：

```sh
curl -fsSL https://cdn.jsdelivr.net/gh/alexzhong233/luci-app-hub@main/deploy.sh | sh
```

刷机后 overlay 被清空，重跑一次即可；`/etc/config/hub` 已存在时不会被覆盖。

编进固件的话，把本仓库放进 `package/` 并打开 `CONFIG_PACKAGE_luci-app-hub=y`。

## 命令行

```sh
/usr/libexec/hub-ctl status                    # key=value 形式的状态
/usr/libexec/hub-ctl install qbittorrent       # 按当前 variant 安装（后台任务）
/usr/libexec/hub-ctl install qbittorrent docker-ee   # 指定变体，页面就是走这条
/usr/libexec/hub-ctl start|stop|restart qbittorrent|openlist
/usr/libexec/hub-ctl logs qbittorrent 40
/usr/libexec/hub-ctl remove openlist           # 卸载，数据目录保留
```

## 数据保留

三个问题分开答。

### 升级固件（sysupgrade 勾「保留配置」）

数据默认放 `/mnt/sda1/Configs/services/<服务>`，**sysupgrade 根本不碰 `/mnt`**，
所以升级不影响。`/etc/config/hub`（端口、运行方式、数据目录这些设置）在
base-files 默认保留的 `/etc/config/` 里，也留得住。

包还带了一份 `/lib/upgrade/keep.d/luci-app-hub`，列了 `/etc/qBittorrent`、
`/etc/openlist2`、`/etc/openlist`。这是兜底的：`/mnt/sda1` 没挂上时 ctl 会退回
`/etc`，那时数据在 overlay 上，不列出来就会随刷机消失。

### 切换运行方式（原生 ↔ 容器）

**数据是共用的。** 做法是把原生目录变成指向 datadir 的符号链接：

```
/etc/qBittorrent  ->  /mnt/sda1/Configs/services/qbittorrent
/etc/openlist2    ->  /mnt/sda1/Configs/services/openlist
/etc/openlist     ->  /mnt/sda1/Configs/services/openlist
```

目录层级天然对齐，不需要搬文件：

| 运行方式 | qB 读到的 | OpenList 读到的 |
|---|---|---|
| 原生 | `<dir>/config/qBittorrent.conf` | `<dir>/data.db` |
| 容器 | `/config/qBittorrent.conf`（挂 `<dir>/config`） | `/opt/openlist/data/data.db`（挂 `<dir>`） |

所以原生官方版 ↔ 原生 EE ↔ 容器官方版 ↔ 容器增强版任意互切，配置、种子、
`.fastresume` 做种记录、存储挂载、账号密码全都在。

第一次启用时会自动迁移：如果 `/etc/qBittorrent` 已经是装满数据的真实目录，
内容会并进 datadir，**datadir 里已有的同名文件不覆盖**（用户数据优先），
然后把目录换成链接。装包前会先摘掉链接，避免 apk 解包时把初始 `data.db`
写穿到真实库上。

### 刷机之后

**数据不丢，程序要重装一次。**

原生版（qB / openlist2 / feeds openlist）是 `apk add` 装到 overlay 上的，
sysupgrade 会清空 overlay —— 包没了。但 `/mnt/sda1` 上的数据原封不动，
`/etc/config/hub` 里的运行方式和端口也都留着（`/etc/config/` 默认保留）。

刷完打开页面，运行方式还是你上次选的那个，点一下「安装」就回来了：

- 原生版：重新下载 37 MB（qB + Qt6）或 22 MB（openlist2），然后 `link_datadir`
  自动把 `/etc/qBittorrent` 链回 `/mnt` —— 配置、种子、`.fastresume` 立刻就位
- 容器版：`docker compose up -d` 重建容器。**前提是 Docker 的 data-root 在
  `/mnt` 上**，那样镜像还留着，秒起；如果 data-root 在 overlay（默认
  `/var/lib/docker`），镜像也会没，得重新 pull

页面会在 Docker 数据目录不在 `/mnt` 时给出提示。改成 `/mnt` 是一次性的：

```sh
uci set dockerd.globals.data_root='/mnt/sda1/docker'
uci commit dockerd
/etc/init.d/dockerd restart
```

`dockerd` 的 init 读的是 `config globals` 段的 `data_root`（默认 `/opt/docker/`，
就在 overlay 上），然后生成 `/etc/docker/daemon.json` 的 `data-root`。改完
`docker info | grep 'Docker Root Dir'` 确认。

改完要重新 pull 一次镜像（旧镜像在 overlay 上，不会自动搬），但从那以后
容器版和 1Panel 的镜像都能跨刷机保留。

**为什么不把包塞进 keep.d**：sysupgrade 保留的是文件，但 `/usr/bin/qbittorrent-nox`
加上 Qt6 那套库有 30 多 MB，打进备份包既慢又容易在恢复时出问题；而且 OpenWrt
的包管理器状态（`/lib/apk`）不在保留集里，恢复出来的文件是"孤儿包"，以后
`apk del` 都删不掉。点一次按钮比这干净。

### 卸载

`remove` 只删包和容器，不动 datadir。页面上会显示数据目录的实际路径。

## 端口与密码

默认端口：

| 服务 | 默认 | 说明 |
|---|---|---|
| qBittorrent WebUI | 8090 | 避开 8080，Nikki/mihomo 默认占那个端口 |
| qBittorrent BT | 21142 | 需要防火墙放行 TCP + UDP |
| OpenList | 5244 | |
| 1Panel | 10086 | 沿用原有配置 |
| WorkBuddy2API | 8788 | 沿用原有配置 |

怎么改：

| 项目 | 怎么设 | 什么时候生效 |
|---|---|---|
| qB WebUI 端口 | 页面填，改完自动重启 | 立即 |
| qB BT 端口 | 同上 | 立即 |
| qB WebUI 密码 | 页面填新密码点「设置」 | 立即 |
| OpenList 端口 | 页面填，改完自动重启 | 原生版立即；容器 host 网络固定 5244 |
| bridge 映射端口 | 容器网络选 bridge 后多出一个「映射端口」 | 立即（重建容器） |
| OpenList 管理员密码 | 页面填新密码点「设置」 | 立即 |

容器网络选 **bridge** 时会多出一个「映射端口」：容器里仍监听原来那个端口
（qB 的 `WEBUI_PORT` 与 conf、OpenList 固定的 5244），宿主机侧用这个映射端口对外，
所以 8080 被 Nikki 占着也可以把 qB 映射到 18090 之类。host 网络下没有映射，端口就是
「端口」那个值。

端口会同步写进各包自己的配置（`qbittorrent.config.http_port`、
`qBittorrent.conf` 的 `WebUI\Port` / `Session\Port`、`openlist2.config.port`、
`openlist.config.listen_http_port`）—— hub 的 UCI 只是入口，不同步的话
包的 init 读不到，改了也不生效。

**qB 密码不用 PBKDF2 硬算**：那个格式要 100000 轮 PBKDF2-HMAC-SHA512，shell
里生成不了。做法是先把 `127.0.0.1` 加进免密白名单，从路由器本机调 qB 自己的
`/api/v2/app/setPreferences`，qB 自己算 hash。副作用是**本机免密**——忘了密码
时从路由器上还能进去改，LAN 访问照旧要密码。

**OpenList 密码**走二进制自带的命令：`openlist2 --data <dir> admin set <密码>`
（容器版是 `docker exec openlist ./openlist admin set`），直接写库，不用重启。

密码通过 `fs.exec` 的环境参数传（`HUB_PASS`），argv 里只有 `-`，`ps` 看不到明文。

## openlist2 是怎么装的

固件不带 openlist2，它的源码仓库里也没有现成二进制（`Makefile` 是编译期从
OpenList 源码构建的 Go 程序）。但作者给每个架构都出了预编译包：

```
https://github.com/sbwml/luci-app-openlist2/releases/latest/download/openwrt-<sdk>-<arch>.tar.gz
```

解开就是 `packages_ci/` 下三个包（`openlist2`、`luci-app-openlist2`、中文翻译），
总共约 22 MB。`hub-ctl` 的 `ol2_fetch()` 做三件事：

1. 从 `/etc/openwrt_release` 读 `DISTRIB_ARCH`，按包管理器定 SDK
   （有 `apk` → `openwrt-25.12`，有 `opkg` → `openwrt-24.10`）
2. 下载，直连失败自动换 `gh-proxy.com` 镜像
3. `apk add --allow-untrusted` / `opkg install --force-downgrade` 本地装那三个包

所以页面上「原生 · openlist2」这个选项**不需要固件预装、也不需要源里有这个包**，
点安装就会现下载。卸载时三个包一起删，`/etc/openlist2` 的数据保留。

## 已知问题

- **原生版和容器版共用同一个端口**，同一时刻只能跑一个。切换时先「卸载」再选另一种「安装」；直接点安装会把对方停掉，但两个实现同时存在时状态栏会标 `conflict=1`。
- **qBittorrent 容器版的 `WEBUI_PORT` 只在首次启动时生效**，之后端口以 `config/qBittorrent.conf` 为准。hub 在启动前会把 hub 里配的端口写进这个文件，所以页面上改端口仍然有效。
- **OpenList 容器版在 host 网络下固定监听 5244**（端口写在容器自己的配置里）。要换宿主机端口得切 bridge，compose 会映射 `宿主机端口:5244`。
- **原生版和容器版共用同一个端口**，切换时 ctl 会自动停掉另一边，不用先手动卸载。
