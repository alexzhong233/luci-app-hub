#!/bin/sh
# 把 luci-app-hub 铺到路由器上，不用重刷固件。
#
# 用法（两条任选，哪条通走哪条）：
#   curl -fsSL https://raw.githubusercontent.com/alexzhong233/luci-app-hub/main/deploy.sh | sh
#   curl -fsSL https://cdn.jsdelivr.net/gh/alexzhong233/luci-app-hub@main/deploy.sh | sh
#
# 幂等：重复执行覆盖同一批文件，/etc/config/hub 已存在时不动（保留你的设置）。
# 刷机后 overlay 被清空，重跑一次即可。

REPO="alexzhong233/luci-app-hub"
BRANCH="main"

RAW="https://raw.githubusercontent.com/$REPO/$BRANCH"
CDN="https://cdn.jsdelivr.net/gh/$REPO@$BRANCH"

TMP="/tmp/hub-deploy.$$"
mkdir -p "$TMP" || exit 1
trap 'rm -rf "$TMP"' EXIT

log() { echo "== $*"; }
die() { echo "!! $*" >&2; exit 1; }

fetch() {
	local rel="$1" out="$2"

	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --connect-timeout 10 --max-time 90 -o "$out" "$RAW/$rel" && return 0
		log "raw.githubusercontent.com 不通，换 jsDelivr"
		curl -fsSL --connect-timeout 10 --max-time 90 -o "$out" "$CDN/$rel" && return 0
	elif command -v uclient-fetch >/dev/null 2>&1; then
		uclient-fetch -q -O "$out" "$RAW/$rel" && return 0
		log "raw.githubusercontent.com 不通，换 jsDelivr"
		uclient-fetch -q -O "$out" "$CDN/$rel" && return 0
	else
		die "没有 curl 或 uclient-fetch，先装一个：apk add curl"
	fi

	return 1
}

install_file() {
	local rel="$1" dst="$2" mode="$3" base size

	base=$(basename "$rel")
	log "下载 $base"
	fetch "$rel" "$TMP/$base" || die "$rel 下载失败（两条线路都不通）"

	# 404 页面、被 .gitignore 吞掉的占位都可能很小，铺上去就是坏脚本。
	size=$(wc -c <"$TMP/$base")
	[ "$size" -gt 100 ] || die "$rel 只有 $size 字节，不像正常内容"

	mkdir -p "$(dirname "$dst")" || die "无法创建 $(dirname "$dst")"
	cp -f "$TMP/$base" "$dst" || die "写入 $dst 失败"
	chmod "$mode" "$dst"
	echo "   -> $dst ($size 字节)"
}

install_file "root/usr/libexec/hub-ctl" "/usr/libexec/hub-ctl" 0755
install_file "root/usr/libexec/1panel-ctl" "/usr/libexec/1panel-ctl" 0755
install_file "root/usr/libexec/workbuddy2api-ctl" "/usr/libexec/workbuddy2api-ctl" 0755
install_file "root/etc/init.d/workbuddy2api-rust" "/etc/init.d/workbuddy2api-rust" 0755
install_file "root/usr/share/luci/menu.d/luci-app-hub.json" \
	"/usr/share/luci/menu.d/luci-app-hub.json" 0644
install_file "root/usr/share/rpcd/acl.d/luci-app-hub.json" \
	"/usr/share/rpcd/acl.d/luci-app-hub.json" 0644
install_file "htdocs/luci-static/resources/view/hub/main.js" \
	"/www/luci-static/resources/view/hub/main.js" 0644

# 配置文件是 conffile：已经有就说明用户改过，别覆盖
if [ -f /etc/config/hub ]; then
	log "/etc/config/hub 已存在，保留现有设置"
else
	install_file "root/etc/config/hub" "/etc/config/hub" 0644
fi

# 旧的单服务菜单会和新页面重复，提示但不自动删（可能还有人在用）
for OLD in /usr/share/luci/menu.d/luci-app-1panel.json \
	/usr/share/luci/menu.d/luci-app-workbuddy2api.json; do
	[ -f "$OLD" ] && log "发现旧菜单 $OLD，如需隐藏请手动删除后重启 rpcd"
done

log "重启 rpcd / 清 LuCI 缓存"
/etc/init.d/rpcd restart >/dev/null 2>&1
rm -f /tmp/luci-indexcache* /tmp/luci-modulecache/* 2>/dev/null

log "自检"
/usr/libexec/hub-ctl status 2>&1 | head -n 20 || true

cat <<'EOF'

装好了。浏览器 Ctrl+Shift+R 强刷，菜单：服务 → 服务合集

四个页签：
  qBittorrent   原生官方版 / 原生增强版 / 容器官方版 / 容器增强版
  OpenList      openlist2 / feeds 官方版 / 容器版
  1Panel        沿用原有 ctl，这里只做状态与入口
  WorkBuddy2API 同上

命令行：
  /usr/libexec/hub-ctl status
  /usr/libexec/hub-ctl install qbittorrent
  /usr/libexec/hub-ctl start|stop|restart qbittorrent|openlist
  /usr/libexec/hub-ctl logs qbittorrent 40

数据目录优先级：UCI 显式指定 > /mnt/sda1/Configs/services/<svc> > 原生位置
（/etc/qBittorrent、/etc/openlist2）。切换运行方式不会动数据。
EOF
