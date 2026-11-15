#!/bin/sh
# ---------------------------------------------------------------------------
# magpie —— AI 模型网关，在 OpenWrt / ImmortalWrt 上用 Docker 部署
#
#   在路由器上：
#     sh install.sh                 # 首次安装 / 升级（保留密钥、providers、用量）
#     sh install.sh --port 3430     # 改控制台端口
#     sh install.sh --dry-run       # 只生成配置，不拉镜像不启动
#
#   一条命令（之后不用再上传文件）：
#     wget -O - https://raw.githubusercontent.com/alexzhong233/luci-app-hub/main/deploy/magpie/install.sh | sh
#
# 为什么是 host 网络：容器在 bridge 下出网会撞上 Nikki 的 prerouting 劫持
# （TCP 被 redirect 到 mihomo 后直接 RST），而 host 网络下它就是路由器本机
# 进程，Nikki 按域名分流 —— 海外 provider 走节点、国内 provider 直出。
# ---------------------------------------------------------------------------

set -u

UI_PORT=3430
GW_PORT=3425
DRY_RUN=0
DATA_OVERRIDE=""
PORT_SET=0

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die() { printf '\033[1;31m!!\033[0m  %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
	case "$1" in
	--port)
		UI_PORT="${2:-}"
		case "$UI_PORT" in
		'' | *[!0-9]*) die "--port 需要一个数字" ;;
		esac
		PORT_SET=1
		shift 2
		;;
	--data)
		DATA_OVERRIDE="${2:-}"
		[ -n "$DATA_OVERRIDE" ] || die "--data 需要一个目录"
		shift 2
		;;
	--dry-run) DRY_RUN=1; shift ;;
	-h | --help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
	*) die "未知参数：$1" ;;
	esac
done

# ---------------------------------------------------------------- 前置检查
if [ "$DRY_RUN" != 1 ]; then
	command -v docker >/dev/null 2>&1 || die "没有 docker，先装 dockerd（或从 1Panel 装）"
	docker info >/dev/null 2>&1 || die "docker 没在跑：/etc/init.d/docker start"

	if docker compose version >/dev/null 2>&1; then
		COMPOSE="docker compose"
	elif command -v docker-compose >/dev/null 2>&1; then
		COMPOSE="docker-compose"
	else
		die "缺 compose：apk add docker-cli-compose，或用 1Panel 装一次容器应用"
	fi
else
	COMPOSE="echo [dry-run] docker compose"
fi

# ---------------------------------------------------------------- 数据目录
# 和 hub 里其它服务同一套约定：/mnt/sda1/Configs/<服务>，没有数据盘才退 /opt。
# /config 里装的是 providers、登录态、网关密钥和用量统计，丢了等于重配一遍，
# 所以必须落在能保留的位置，绝不进 overlay。
if [ -n "$DATA_OVERRIDE" ]; then
	ROOT=""
elif [ -d /mnt/sda1 ] && mountpoint -q /mnt/sda1 2>/dev/null && [ -w /mnt/sda1 ]; then
	ROOT=/mnt/sda1/Configs
elif [ -d /opt ] && [ -w /opt ]; then
	ROOT=/opt/Configs
	warn "数据盘没挂上，退到 $ROOT（在 overlay 上，刷机会丢）"
else
	die "/mnt/sda1 和 /opt 都不可写"
fi

if [ -n "$DATA_OVERRIDE" ]; then
	DATA="$DATA_OVERRIDE"
else
	DATA="$ROOT/magpie"
fi
mkdir -p "$DATA" || die "建不了 $DATA"
chmod 700 "$DATA" 2>/dev/null

# ---------------------------------------------------------------- 密钥
# MAGPIE_WEB_KEY 必须 ≥16 位。它跟着 .env 走，重启不变 —— 否则每次启动都换一把，
# 浏览器 400 天的登录态就白给了。
ENVF="$DATA/.env"

# 没显式给 --port 时沿用上次的端口 —— 否则重跑一次就退回 3430，
# 浏览器里存的地址和 MAGPIE_PUBLIC_URL 一起失效
if [ "$PORT_SET" = 0 ] && [ -s "$ENVF" ]; then
	OLD_PORT=$(sed -n 's|^MAGPIE_UI_PORT=||p' "$ENVF" | head -n 1)
	case "$OLD_PORT" in
	'' | *[!0-9]*) ;;
	*) UI_PORT="$OLD_PORT" ;;
	esac
fi

KEY=""
[ -s "$ENVF" ] && KEY=$(sed -n 's/^MAGPIE_WEB_KEY=//p' "$ENVF" | head -n 1)

if [ -z "$KEY" ]; then
	KEY=$(openssl rand -hex 16 2>/dev/null)
	if [ -z "$KEY" ]; then
		# busybox 不一定有 openssl
		KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
	fi
	[ -n "$KEY" ] || die "生成密钥失败"
	say "生成新的控制台密钥"
else
	say "沿用已有的控制台密钥"
fi

# ---------------------------------------------------------------- 对外地址
IP=$(uci -q get network.lan.ipaddr 2>/dev/null)
IP=${IP%%/*}
if [ -z "$IP" ]; then
	IP=$(ip -4 addr show br-lan 2>/dev/null |
		awk '/inet /{sub(/\/.*/, "", $2); print $2; exit}')
fi
[ -n "$IP" ] || IP=192.168.1.1

# ---------------------------------------------------------------- compose
COMPOSE_FILE="$DATA/docker-compose.yml"
cat >"$COMPOSE_FILE" <<'YAML'
# 由 deploy/magpie/install.sh 生成，手改会被下次执行覆盖。
# 要调参数：改同目录的 .env，或重跑 install.sh --port <端口>。
services:
  magpie:
    image: ghcr.io/yetone/magpie:latest
    container_name: magpie
    # host：等同路由器本机进程，出网由 Nikki 按域名分流。
    # 换成 bridge 会撞 Nikki 的 prerouting 劫持 —— TCP 直接被拒，连不上任何 provider。
    network_mode: host
    environment:
      TZ: Asia/Shanghai
      MAGPIE_WEB_KEY: "${MAGPIE_WEB_KEY}"
      MAGPIE_PUBLIC_URL: "${MAGPIE_PUBLIC_URL}"
    volumes:
      # providers / 登录态 / 网关密钥 / 用量，全在这里
      - "${MAGPIE_DATA}:/config"
    # 不带 web 子命令时只跑 serve（纯网关，没有页面）；
    # --no-open 是必需的：容器里没有浏览器，不去尝试打开
    command: ["web", "--addr", "0.0.0.0:3430", "--no-open"]
    restart: unless-stopped
YAML

cat >"$ENVF" <<EOF
# 由 install.sh 维护。改完 docker compose up -d 生效。
MAGPIE_WEB_KEY=$KEY
# 这是「别的机器怎么找到网关」，Magpie 会把它写进给 agent 的配置里，
# 所以必须是网关端口 $GW_PORT，不是控制台的 $UI_PORT。
MAGPIE_PUBLIC_URL=http://$IP:$GW_PORT
MAGPIE_UI_PORT=$UI_PORT
MAGPIE_DATA=$DATA
EOF
chmod 600 "$ENVF"

# --port 改了的话，命令里那个 3430 也要跟着改
if [ "$UI_PORT" != 3430 ]; then
	sed -i "s#0.0.0.0:3430#0.0.0.0:$UI_PORT#" "$COMPOSE_FILE"
fi

# 镜像里跑的是 uid 65532(nonroot)，bind mount 的目录必须归它，否则起不来
# （报错是 permission denied，或者干脆无限重启）
chown -R 65532:65532 "$DATA" 2>/dev/null ||
	warn "chown 65532 失败 —— 如果数据盘是 exfat/vfat/ntfs，改挂载或换 ext4"

say "配置已写到 $COMPOSE_FILE"
say "数据目录 $DATA"

if [ "$DRY_RUN" = 1 ]; then
	say "dry-run，跳过 pull / up"
	cat "$ENVF"
	exit 0
fi

# ---------------------------------------------------------------- 起服务
say "拉取镜像（ghcr.io，国内可能慢；拉不动见 README）"
# shellcheck disable=SC2086
$COMPOSE --env-file "$ENVF" -f "$COMPOSE_FILE" -p magpie pull ||
	die "拉镜像失败。试：docker pull ghcr.io/yetone/magpie:latest 看具体错误"

say "启动"
# shellcheck disable=SC2086
$COMPOSE --env-file "$ENVF" -f "$COMPOSE_FILE" -p magpie up -d ||
	die "启动失败，看 docker logs magpie"

sleep 4
echo
docker logs --tail 15 magpie 2>&1 | sed 's/^/    /'
echo
say "完成"
cat <<EOF

    控制台    http://$IP:$UI_PORT/?k=$KEY
    网关      http://$IP:$GW_PORT      （agent / 客户端填这个）

    控制台那条链接带密钥，别发到群里。
    第一次进去先在 Providers 里加 provider，再在 Gateway 里建一把网关密钥给局域网用。

EOF
