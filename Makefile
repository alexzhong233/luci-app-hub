include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-hub
PKG_VERSION:=1.0
PKG_RELEASE:=1
PKG_LICENSE:=MIT
PKG_MAINTAINER:=Alex Zhong <alexzhong233@users.noreply.github.com>

LUCI_TITLE:=服务合集：1Panel / WorkBuddy2API / qBittorrent / OpenList
LUCI_DESCRIPTION:=四个服务收进一个页面，页签切换。qBittorrent 支持原生官方版、\
原生增强版、容器官方版、容器增强版四种；OpenList 支持 feeds 版、openlist2、\
容器版三种。数据目录优先挂 /mnt/sda1，刷机不丢。
LUCI_PKGARCH:=all
# bash 是 1Panel 本地版的硬依赖（官方 install.sh 与生成的 1pctl 都是 bash），
# yq 用于 OpenList 容器版的配置校验，curl 用于版本探测与镜像拉取。
LUCI_DEPENDS:=+luci-base +bash +curl

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
