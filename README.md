# 夜场画廊

夜场画廊是一款可自托管的浏览器艺术竞拍游戏。单桌支持 3 至 6 名参赛者，参赛和观战合计最多 10 人。房主设置规则、开局及暂停。玩家可以从手机、平板或电脑加入，关闭页面后可用原浏览器找回席位。

- [规则与房主操作手册](RULES.md)
- [画作制作说明](ART.md)

## 快速开始

在装有 Docker 和 Compose v2 的机器上，解压源码归档或进入克隆后的目录。构建时需要访问 Docker 镜像仓库和 npm。部署时请在项目根目录运行：

```bash
docker compose up -d --build
docker compose ps
```

1. 在同一台机器上访问 `http://localhost:8080`。局域网或远程玩家用可访问的服务器 IP 或域名。
2. 房主创建房间，选择拍卖方式、展期、时限和观战权限。
3. 房主用其他成员也能访问的地址打开页面，从「房间管理」复制邀请链接。至少 3 名参赛者在线后，点「开始游戏」。首次进房可查看五步指引。

在同一目录再次运行 `docker compose up -d --build` 即可重建容器，并继续使用现有数据卷。已打开的页面刷新后会载入新版。

## 部署配置

需要修改配置时，运行 `cp .env.example .env`，编辑后重新执行 `docker compose up -d`。

| 配置项 | 默认值 | 用途 |
| --- | --- | --- |
| `GALLERY_PORT` | `8080` | 对外端口 |
| `GALLERY_BIND` | `0.0.0.0` | 监听地址。反向代理与容器在同一主机时可设为 `127.0.0.1` |
| `ROOM_CREATE_KEY` | 空 | 建房密钥。公网首次启动前建议设置，受邀参赛或观战只需邀请链接 |
| `PUBLIC_ORIGIN` | 空 | 配置反向代理时可设为对外地址，例如 `https://gallery.example.com` |

HTTPS 反向代理需转发所有路径，保留对外请求主机，并为 `/live` 转发 WebSocket Upgrade。服务端提供页面、图片和 WebSocket，运行时由单个容器承载。

### 直接运行 Docker 容器

```bash
docker build -t night-gallery:local .
docker volume create night-gallery-data
docker run -d --init --read-only --restart unless-stopped \
  --name night-gallery -p 8080:8080 \
  -v night-gallery-data:/data night-gallery:local
```

用 `docker compose logs -f gallery` 查看服务日志。用 `curl -fsS http://127.0.0.1:8080/healthz` 检查服务是否响应。单个持久卷对应一桌，请为每份数据只启动一个容器。

## 持久化与迁移

容器使用 `/data/room.json` 保存房间、席位和当前拍卖。Compose 将它保存在命名卷中，普通重建会继续使用该卷。沿用同一个域名和端口时，浏览器会自动恢复席位。如果要换访问地址，请先在原地址的「房间管理」保存个人席位恢复码，迁移后在新地址的首页点击「使用席位恢复码」。

下面的命令用 Compose 迁移已有房间。空房服务器没有 `room.json` 前可直接部署。

在旧服务器上停止写入并备份。

```bash
docker compose stop gallery
umask 077
docker compose run --rm --no-deps -T gallery cat /data/room.json > night-gallery-room.json
```

将项目与备份复制到新服务器。恢复数据后再启动。

```bash
docker compose build gallery
docker compose run --rm --no-deps -T gallery sh -c \
  'umask 077 && cat > /data/room.json.tmp && mv /data/room.json.tmp /data/room.json' < night-gallery-room.json
docker compose up -d
```

请将备份和邀请链接视为私有数据。删除数据卷会清除房间与比赛。服务器停机跨过当前拍卖阶段的截止时间时，启动后会结算这个阶段，并给下一阶段完整操作时间。

游戏暂停时，剩余时间、当前拍品和已提交报价随数据保存。重启后仍处于暂停，直到房主点击「继续游戏」。

## 验证

可使用与容器一致的 Node.js 22 复测规则和联机协议。

```bash
npm ci
npm test
```

用容器完成浏览器联机验证。默认测试用 Chromium，可以用 `CHROME_BIN` 指定已有的 Chrome。

```bash
npx playwright install chromium
docker build -t night-gallery:local .
npm run test:browser
npm run test:bandwidth
```

手机和平板交互可用 WebKit 复测。Linux 测试机需要 Playwright 的 WebKit 系统依赖。

```bash
npx playwright install webkit
npm run test:mobile
```

以上三个脚本分别启动临时容器和命名卷，结束后清理。移动端测试覆盖 iPhone 17、iPhone 18 Pro / Pro Max、iPad 和两代 iPad mini 的模拟视口，检查横竖屏、触控、指引、掉线后恢复及暂停时重启容器。屏幕规格参考 Apple 的 [iPhone 17](https://www.apple.com/iphone-17/specs/)、[iPhone 18 Pro / Pro Max](https://www.apple.com/iphone-18-pro/specs/)、[iPad](https://support.apple.com/en-us/122240)、[iPad mini A17 Pro](https://support.apple.com/en-lamr/121456) 和 [iPad mini A20 Pro](https://support.apple.com/en-us/149482)。

带宽脚本在 **10 个连接共享的 1 Mbps 下载通道**中测试首次加载和连续拍卖状态更新，并输出下行体积及延迟。对局用 WebSocket 按字段更新，倒计时在客户端刷新。切回前台时会请求一次最新状态。缩略图与普通界面独立缓存，大图在点击时加载，空闲时只有连接保活。

本地 Docker 的一次限速测试中，10 个客户端冷加载页面与全部 8 张缩略图用了约 4.5 秒。连续 18 次报价向全桌同步用了约 21 KB 下行数据，送达全部连接的延迟 P95 为 124 ms。10 个客户端同时请求大图时，期间的一次竞价更新在 154 ms 内送达。测试在本机限速代理中完成，公网实际延迟取决于线路。

## 素材来源与许可

本项目的规则、规则手册文字与界面独立编写。Reiner Knizia 的《现代艺术》是题材参考，出版信息见 [CMON 产品页](https://www.cmon.com/products/modern-art/)。

卡面由 ImageGen 生成并导出为 WebP，生成方式及提示词见[画作制作说明](ART.md)。本项目的源码、文档和卡面尚未声明面向公众的开源或素材许可。

运行时依赖 `ws` 使用 MIT 许可。浏览器测试使用 Apache-2.0 许可的 `playwright` 和 `playwright-core`，以及在 macOS 上可选安装的 MIT 依赖 `fsevents`。具体版本见 [package-lock.json](package-lock.json)。依赖及 Docker 基础镜像中的软件各自适用其上游许可。
