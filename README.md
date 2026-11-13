# luci-app-hub

把四个常用服务收进一个 LuCI 页面，页签切换。

| 页签 | 运行方式 |
|---|---|
| **qBittorrent** | 原生官方版 · 原生增强版（EE，反吸血） · 容器官方版 · 容器增强版 |
| **OpenList** | openlist2（sbwml） · feeds 官方版 · 容器版 |
| **1Panel** | 沿用原有 ctl，本页只做状态汇总和入口跳转 |
| **WorkBuddy2API** | 同上 |

## 为什么合并

qBittorrent 在 OpenWrt 上的原生包有个反复踩的坑：`/etc/init.d/qbittorrent` 每次
启动都 `sed -i` 把 UCI 里的 `http_port` 写进 `qBittorrent.conf`，而 qBittorrent 收到
SIGTERM 时又会把内存里的配置写回文件——两者次序不固定，改端口时好时坏。

容器版没有这个问题：配置在 volume 里，端口在 compose 里，跟 init 脚本无关。把四种
运行方式放在同一个页面并统一数据目录，切换时不用再记每种的路径和端口规则。

1Panel 和 WorkBuddy2API 的逻辑没有重写，`1panel-ctl` / `workbuddy2api-ctl` 原样
放进同一个包，页面直接调用——它们已经跑稳，为了"合并"再动一遍只会引入风险。

## 数据目录

按顺序取第一个可用的：

1. `hub.<服务名>.datadir`（UCI 里显式指定）
2. `/mnt/sda1/Configs/services/<服务名>`（`/mnt/sda1` 已挂载且可写时）
3. 该服务原生版的位置（`/etc/qBittorrent`、`/etc/openlist2`、`/etc/openlist`）

qBittorrent 的 `config` 子目录里是 `qBittorrent.conf` 和 `BT_backup`，后者装着种子
和做种记录，**切换运行方式或重装都不要删这个目录**。

## 端口

| 服务 | 默认 | 说明 |
|---|---|---|
| qBittorrent WebUI | 8090 | 避开 8080，Nikki/mihomo 默认占那个端口 |
| qBittorrent BT | 21142 | 需要防火墙放行 TCP + UDP |
| OpenList | 5244 | |
| 1Panel | 10086 | 沿用原有配置 |
| WorkBuddy2API | 8788 | 沿用原有配置 |

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
/usr/libexec/hub-ctl start|stop|restart qbittorrent|openlist
/usr/libexec/hub-ctl logs qbittorrent 40
/usr/libexec/hub-ctl remove openlist           # 卸载，数据目录保留
```

## 已知问题

- **原生版和容器版共用同一个端口**，同一时刻只能跑一个。切换时先「卸载」再选另一种「安装」；直接点安装会把对方停掉，但两个实现同时存在时状态栏会标 `conflict=1`。
- **OpenList 从原生切容器**时，`data.db` 会被原地接管（同一个目录）。切换前先停服务，避免 SQLite 的 WAL 处于写入状态。
- **qBittorrent 的 `WebUI_PORT` 只在容器首次启动时生效**，之后改端口要改 `config/qBittorrent.conf` 里的 `WebUI\Port`，环境变量不再起作用。
