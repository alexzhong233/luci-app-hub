#!/bin/sh
# ---------------------------------------------------------------------------
# 清理 Ravomi/luci-app-magpie（方案 A）在系统里留下的残余，顺带体检 LuCI。
#
#   sh cleanup.sh --check    # 只看，不删
#   sh cleanup.sh            # 体检 → 备份 /etc/magpie → 删 → 清缓存 → 重启 rpcd
#
# 为什么需要这个脚本：它的 install.sh 在 apk 系统上走的不是包管理器，而是
# `tar -C / -xzf rootfs.tar.gz` 直接铺文件 —— apk/opkg 完全不知道这些东西存在，
# 所以 `apk del magpie` 什么都删不掉，只能按清单手动清。
# ---------------------------------------------------------------------------

set -u

MODE=clean
[ "${1:-}" = "--check" ] && MODE=check

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
sec() { printf '\n\033[1m--- %s ---\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }

# ------------------------------------------------------------------ 体检
health() {
	sec "LuCI / rpcd"
	if pgrep -f '/sbin/rpcd|/usr/sbin/rpcd' >/dev/null 2>&1; then
		printf '  rpcd 进程      : 在跑 (pid %s)\n' "$(pgrep -f '/sbin/rpcd|/usr/sbin/rpcd' | head -n1 | tr '\n' ' ')"
	else
		printf '  rpcd 进程      : \033[1;31m没在跑\033[0m\n'
	fi
	# ubus 里 luci 对象在不在，是「菜单树能不能构建」的直接证据
	if ubus -S list luci >/dev/null 2>&1; then
		printf '  ubus luci 对象 : 正常\n'
	else
		printf '  ubus luci 对象 : \033[1;31m缺失（所有 LuCI 页面都会 404/500）\033[0m\n'
	fi

	sec "页面文件"
	for f in \
		/www/luci-static/resources/view/hub/main.js \
		/www/luci-static/resources/view/magpie/hub.js \
		/www/luci-static/resources/tools/magpie.js \
		/usr/share/rpcd/ucode/luci.hub \
		/usr/share/rpcd/ucode/luci.magpie; do
		if [ -e "$f" ]; then
			printf '  有  %-52s %s\n' "$f" "$(du -h "$f" 2>/dev/null | cut -f1)"
		else
			printf '  --  %s\n' "$f"
		fi
	done

	sec "菜单 / ACL"
	for d in /usr/share/luci/menu.d /usr/share/rpcd/acl.d; do
		printf '  %s:\n' "$d"
		ls "$d" 2>/dev/null | grep -iE 'hub|magpie|workbuddy' | sed 's/^/     /'
	done

	sec "workbuddy2api"
	if pgrep -f workbuddy >/dev/null 2>&1; then
		# busybox 的 pgrep 不一定有 -a，直接读 cmdline 更保险
		for p in $(pgrep -f workbuddy); do
			printf '  pid %-6s %s\n' "$p" "$(tr '\0' ' ' <"/proc/$p/cmdline" 2>/dev/null)"
		done
	else
		echo "  没有进程"
	fi
	for s in /etc/init.d/workbuddy2api /etc/init.d/workbuddy2api-rust; do
		[ -x "$s" ] && printf '  %s : %s\n' "$s" \
			"$("$s" status >/dev/null 2>&1 && echo running || echo stopped)"
	done
	ls /etc/rc.d/ 2>/dev/null | grep -i workbuddy | sed 's/^/  自启: /'
	[ -f /etc/config/workbuddy2api ] && printf '  uci 段存在: %s\n' \
		"$(uci -q show workbuddy2api 2>/dev/null | head -n3 | tr '\n' ' ')"

	sec "磁盘"
	printf '  overlay: %s\n' "$(df -h / 2>/dev/null | awk 'NR==2{print $4" 可用 / "$2}')"

	sec "magpie 残余"
	local n=0
	while IFS= read -r p; do
		[ -e "$p" ] || continue
		printf '  %-10s %s\n' "$(du -sh "$p" 2>/dev/null | cut -f1)" "$p"
		n=$((n + 1))
	done <<'LIST'
/usr/bin/magpie
/etc/magpie
/etc/init.d/magpie
/etc/config/magpie
/etc/config/magpie.default
/usr/libexec/magpie-ctl
/usr/lib/lua/luci/i18n/magpie.zh-cn.lmo
/usr/share/rpcd/acl.d/luci-app-magpie.json
/usr/share/rpcd/ucode/luci.magpie
/usr/share/luci/menu.d/luci-app-magpie.json
/www/luci-static/resources/view/magpie
/www/luci-static/resources/tools/magpie.js
/etc/rc.d/S99magpie
/var/log/magpie.log
LIST
	[ "$n" = 0 ] && echo "  干净"
}

if [ "$MODE" = check ]; then
	health
	echo
	say "只体检，没动任何文件。要清理去掉 --check"
	exit 0
fi

# ------------------------------------------------------------------ 清理
say "停服务"
[ -x /etc/init.d/magpie ] && /etc/init.d/magpie stop >/dev/null 2>&1
[ -x /etc/init.d/magpie ] && /etc/init.d/magpie disable >/dev/null 2>&1
killall magpie >/dev/null 2>&1
sleep 1
killall -9 magpie >/dev/null 2>&1

# 走包管理器的情形（opkg 系统装过 ipk 时才有意义），apk 系统上是空操作
if command -v opkg >/dev/null 2>&1; then
	opkg remove magpie luci-app-magpie luci-i18n-magpie-zh-cn >/dev/null 2>&1
fi
if command -v apk >/dev/null 2>&1; then
	apk del magpie luci-app-magpie luci-i18n-magpie-zh-cn >/dev/null 2>&1
fi

# /etc/magpie 里可能有已配好的 provider 和密钥，先留一份再删
if [ -d /etc/magpie ] && [ -n "$(ls -A /etc/magpie 2>/dev/null)" ]; then
	B=/root/magpie-config-backup-$(date +%m%d-%H%M)
	cp -a /etc/magpie "$B" 2>/dev/null && say "已把 /etc/magpie 备份到 $B"
fi

say "删文件"
for p in \
	/usr/bin/magpie \
	/etc/init.d/magpie \
	/etc/config/magpie \
	/etc/config/magpie.default \
	/usr/libexec/magpie-ctl \
	/usr/lib/lua/luci/i18n/magpie.zh-cn.lmo \
	/usr/share/rpcd/acl.d/luci-app-magpie.json \
	/usr/share/rpcd/ucode/luci.magpie \
	/usr/share/luci/menu.d/luci-app-magpie.json \
	/www/luci-static/resources/tools/magpie.js \
	/var/log/magpie.log \
	/etc/rc.d/S99magpie; do
	[ -e "$p" ] && rm -f "$p" && printf '  rm %s\n' "$p"
done
for d in /etc/magpie /www/luci-static/resources/view/magpie; do
	[ -d "$d" ] && rm -rf "$d" && printf '  rm -r %s\n' "$d"
done

# luci 的菜单树和模块索引缓存，不清的话页面上还会挂着不存在的入口
say "清 LuCI 缓存"
rm -rf /tmp/luci-indexcache* /tmp/luci-modulecache* /tmp/luci-*cache 2>/dev/null
rm -rf /tmp/.uci 2>/dev/null

say "重启 rpcd"
/etc/init.d/rpcd restart >/dev/null 2>&1
/etc/init.d/uhttpd reload >/dev/null 2>&1
sleep 2

echo
health
echo
say "完成。浏览器请 Ctrl+F5 强制刷新（LuCI 的 js 有长缓存）"
