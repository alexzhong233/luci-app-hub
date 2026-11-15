# magpie —— 路由器上的 AI 模型网关（Docker）

[magpie](https://github.com/yetone/magpie) 把 **OpenAI / Anthropic / Gemini** 三套协议统一到一个端口，
再叠一层多 provider、多账号的额度故障切换。装在路由器上，局域网里所有 agent
（Claude Code、Codex、Cherry Studio、OpenWebUI、手机）共用一个出口和一池 key；
某个订阅额度用尽时它自己换下一个账号，客户端看不到 429。

它**改不了别的机器的 agent 配置**（那靠本地 CLI 写 `~/.claude/settings.json`），
在容器里它只是纯 API 网关 —— 客户端要自己填 base_url 和 key。

## 装

```sh
wget -O - https://raw.githubusercontent.com/alexzhong233/luci-app-hub/main/deploy/magpie/install.sh | sh
```

或者把 `install.sh` 传上去 `sh install.sh`。参数：

| 参数 | 作用 |
|---|---|
| `--port <n>` | 控制台端口，默认 3430（重跑不带就沿用上次的） |
| `--data <dir>` | 数据目录，默认 `/mnt/sda1/Configs/magpie`，没数据盘退 `/opt/Configs` |
| `--dry-run` | 只生成配置，不拉镜像不起容器 |

脚本做的事：建数据目录 → 生成/沿用控制台密钥 → 写 `docker-compose.yml` 和 `.env`
→ `chown 65532`（镜像里跑的是 nonroot）→ `docker compose pull && up -d` → 打印地址。

装完得到两个地址：

```
控制台   http://192.168.x.x:3430/?k=<密钥>
网关     http://192.168.x.x:3425
```

## 为什么用 host 网络

这台路由器上 bridge 容器出网会撞上 Nikki 的 prerouting 劫持：TCP 被 redirect 到
mihomo 的 `:7891`，然后被直接拒绝（之前 twitch-drops-miner 就是这么连不上的）。

`network_mode: host` 下容器等同路由器本机进程，走 Nikki 同一套规则，于是：

- 海外 provider（OpenAI / Anthropic / Gemini / OpenRouter / xAI）→ 自动走节点
- 国内 provider（DeepSeek / Kimi / GLM / 通义 / 火山 / 硅基流动）→ mihomo 按域名判 DIRECT，直出

不用给容器配任何 `HTTP_PROXY`。代价是 3425 / 3430 直接占宿主机端口，没有网络隔离。

## 接入客户端

控制台 **Gateway** 页建一把网关密钥（`sk-magpie-…`），然后用：

```sh
# Claude Code
export ANTHROPIC_BASE_URL=http://192.168.x.x:3425
export ANTHROPIC_AUTH_TOKEN=sk-magpie-xxxx

# Codex / 任意 OpenAI 兼容客户端（Cherry Studio、OpenWebUI、NextChat…）
export OPENAI_BASE_URL=http://192.168.x.x:3425/v1
export OPENAI_API_KEY=sk-magpie-xxxx
```

Gemini 接口同端口，按各家客户端要求填 `http://192.168.x.x:3425`。

**订阅登录（ChatGPT / Claude 官方订阅转 API）能做，但流程绕**：点登录会在你的
浏览器里打开厂商页面，登录完成后厂商把浏览器跳回 `localhost` —— 那是**你自己的电脑**，
不是容器，所以页面打不开。这时把地址栏那一整条回调地址复制出来，粘回登录框的
`Callback URL` 字段。Claude 订阅还需要先装 Anthropic 自己的 CLI（镜像里没有）：

```sh
docker exec -it magpie magpie claude-code install
```

嫌麻烦就只用 API key 方式，这已经覆盖绝大多数场景。

## 数据与备份

全部在 `/mnt/sda1/Configs/magpie`：

| 路径 | 内容 |
|---|---|
| `config/magpie/` | `settings.json`、providers、网关密钥、路由组 |
| `config/home/` | 容器的 HOME，登录态（`~/.codex`、`~/.claude`） |
| `config/cache/` | 模型目录、Bun、下载的 Claude Code |
| `config/data`、`config/state` | 其余状态 |
| `docker-compose.yml`、`.env` | 部署配置（含控制台密钥） |

**备份整个目录即可**，它不在 overlay 上，刷机不丢。升级镜像 (`docker compose pull && up -d`)
不会动这些。

## 几个坑

**1. 3430 别往公网暴露。** 控制台链接里带密钥，谁拿到谁能改配置、看所有 provider 的 key。
只在内网用，或者走 SSH 隧道 / 前置带 TLS 的反代。`MAGPIE_WEB_KEY` 已设，重启后登录态保 400 天。

**2. `ghcr.io` 国内经常拉不动。** 报 `TLS handshake timeout` / `connection reset` 时：

```sh
docker pull ghcr.io/yetone/magpie:latest     # 先看真实错误
```

拉不动就走代理（dockerd 不读 shell 的 `HTTP_PROXY`，要在 `/etc/init.d/docker` 里给
守护进程设 `https_proxy`，改完 `/etc/init.d/docker restart`），或者临时用镜像加速前缀。

**3. 内存。** 这是个常驻 Go 进程 + 前端资源，实际常驻 100~200 MB。你这台已经跑着
Nikki、UU、1Panel、OpenList、qBittorrent，装之前先看 `free -m`。

**4. 别改回 bridge。** 改了就连不上任何 provider，报错长这样：

```
curl: (7) Failed to connect to api.openai.com:443 after 128 ms
```

**5. 卸载**：

```sh
cd /mnt/sda1/Configs/magpie && docker compose down
# 数据和配置在卷里，要彻底清就 rm -rf /mnt/sda1/Configs/magpie
```

## 还没做

并进 `luci-app-hub` 的页面（第五个页签：状态 / 端口 / 网关密钥 / 启停 / 日志）。
先单独跑一段时间，确认它在你日常里真的用得上，再固化进 hub —— 这东西是 Go 单体，
版本迭代很快，固化越早、跟着改的成本越高。
