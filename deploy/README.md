# Brass: Lancashire —— 异地/跨设备联机部署（自有 VPS）

目标：让不同网络、不同设备的玩家通过你自己的域名联机，且**服务端规则引擎源码不落地到可读 `.py`**。

> 现有代码已具备：房间系统（`/api/rooms` 建房/列表/加入）、服务端同源托管前端（`web/dist`）、
> 前端 `?api=` 地址可配。所以异地联机 = 把这套东西放到公网可达的 VPS + HTTPS。

---

## 一、准备 VPS（Linux，推荐 Debian/Ubuntu）

1. 买一台 VPS，记下 IP，设好安全组：**只放行 22 与 80/443**（8765 不对外，只听 127.0.0.1）。
2. 绑定域名：在 DNS 把 `brass.你的域名` A 记录指向 VPS IP。
3. 建部署用户：`sudo adduser --disabled-password brass`（用密钥登，禁密码）。
4. 本机配 SSH 免密：`ssh-copy-id brass@VPS_IP`。

## 二、首次同步代码

本机（Git-Bash）执行（改 `deploy/deploy.sh` 顶部的 `VPS_USER/VPS_HOST`）：

```bash
bash deploy/deploy.sh
```

它会 rsync 整个项目到 `/opt/brass`，并在 VPS 上编译二进制、启服。

## 三、VPS 上手动步骤（deploy.sh 已自动做，这里备查）

```bash
# 1) 编译二进制（引擎编进二进制，厂商读不到 .py）
sudo -u brass bash /opt/brass/deploy/build_nuitka.sh

# 2) 进一步隐藏源码（可选，编译成功后）
rm -f /opt/brass/server/app/*.py /opt/brass/engine/*.py /opt/brass/engine/**/*.py

# 3) nginx 反代 + HTTPS
sudo cp /opt/brass/deploy/nginx.brass.conf /etc/nginx/sites-available/brass
sudo ln -s /etc/nginx/sites-available/brass /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d brass.你的域名   # 自动签 HTTPS 并改写 nginx

# 4) systemd 启服
sudo cp /opt/brass/deploy/brass.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now brass

# 5) 防火墙（只开 22/80/443）
sudo ufw allow 22,80,443/tcp && sudo uff enable
```

## 四、玩家怎么联机

1. 房主打开 `https://brass.你的域名` → 大厅「创建房间」→ 拿到**房号**。
2. 把房号发给异地好友。
3. 好友打开 `https://brass.你的域名?room=房号`（或在大厅输入房号加入）。
4. 双方不同网、不同设备（手机/笔记本）即可同时游玩。

## 五、关于「不泄密」

- **规则引擎在服务端**：玩家浏览器只下载 `web/dist` 的 minified JS（渲染层），不含判分/合法性逻辑。
- **VPS 二进制形态**：`build_nuitka.sh` 把 `engine` + `app` 编进 `run.bin`，运行时无需 `.py` 源码；
  即使云厂商有磁盘权限，看到的也是编译产物（可被逆向但门槛高）。**最省事的不泄密方案其实是 Cloudflare Tunnel——源码根本不出你电脑**，本分支你选了 VPS，故走二进制加固。
- **CORS 收紧**：`brass.service` 里 `CORS_ORIGINS=https://brass.你的域名`，防止别人拿你的 API 当免费后端。
- **仓库私有**：`.git` 不推送任何公开平台；`deploy.sh` 已 `--exclude .git`。
- **最小化暴露面**：8765 只听 127.0.0.1，对外仅 443；无源码下载接口。

## 六、更新上线

改完代码后本机重跑 `bash deploy/deploy.sh` 即可（会自动重建二进制并重启）。

## 七、排错

- 打不开页面：`sudo systemctl status brass`、`sudo tail -f /var/log/nginx/error.log`。
- 健康检查：`curl -s http://127.0.0.1:8765/api/health`。
- 数据找不到：确认 `BRASS_ROOT=/opt/brass` 已设（systemd Environment），且 `/opt/brass/data`、`/opt/brass/web/public/data` 存在。
- 长轮询卡：nginx `proxy_read_timeout` 已设 60s；若仍断，调大。

---

## 八、阿里云「云服务器 ECS 免费试用」实操（香港地域）

> 本节针对零基础上阿里云领 1 个月免费试用、把本游戏跑成异地联机的最小路径。
> 已确认：免费试用页的「云服务器 ECS（个人版）」**个人认证即可**、官方明确支持**多人在线游戏部署**、**香港地域免备案**且含 **200GB/月免费出站流量**。

### 8.1 领试用时怎么选

| 选项 | 推荐值 | 说明 |
|---|---|---|
| 产品 | **云服务器 ECS 免费试用（个人版）** | 勿选「轻量应用服务器」（锁定 1GiB 内存，跑不了 Nuitka 编译、且无香港地域） |
| 地域 | **香港** | 非中国内地 → 免备案；对异地好友延迟最友好；200GB/月免费流量 |
| 规格 | **2 vCPU / 2GiB 起** | 300 元额度要在 3 个月内覆盖，香港单价偏高；挑 2C2G 通常撑满 1 个月。编译二进制建议临时升 4GiB（见 8.4） |
| 系统镜像 | **Alibaba Cloud Linux 3** 或 **Ubuntu 22.04** | 都带 sudo，方便装 nginx/Python/Nuitka |
| 公网 | 试用自带**公网 IP + 200GB/月流量** | 记下这个公网 IP，即下方 `VPS_HOST` |
| 时长 | 试用 1 个月 | 到期前可转「99 计划」(大陆需备案) 或香港按需续费 |

### 8.2 安全组（控制台 → 实例 → 安全组）

只放行 **22/80/443**；**8765 不开放到公网**（游戏只走 443，8765 仅听 127.0.0.1）。

```
入方向：22/tcp  (SSH)    来源 0.0.0.0/0  （建议限你本机 IP 更稳）
        80/tcp  (HTTP)   来源 0.0.0.0/0
        443/tcp (HTTPS)  来源 0.0.0.0/0
```

### 8.3 SSH 登录

- **控制台创建密钥对** → 下载 `.pem` → 绑定到实例（重启生效）。
- Alibaba Cloud Linux 默认 **root** 用户；Ubuntu 默认 **ubuntu** 用户。
- 本机登录（把密钥权限收紧）：

  ```bash
  # Alibaba Cloud Linux
  ssh -i ~/.ssh/aliyun-hk.pem root@<公网IP>
  # Ubuntu
  ssh -i ~/.ssh/aliyun-hk.pem ubuntu@<公网IP>
  ```

- 建部署专用用户（推荐，与 README 一节的 `brass` 一致）：

  ```bash
  sudo adduser --disabled-password brass && sudo usermod -aG sudo brass
  # 把本机公钥写进 brass 的 authorized_keys，或把 .pem 也允许 brass 用
  ```

- 之后 `deploy/deploy.sh` 的 `VPS_USER=brass`、`VPS_HOST=<公网IP>` 即可免密 rsync/ssh。

### 8.4 编译内存（香港 2GiB 档的坑）

Nuitka 编译一次很吃内存，2GiB 可能 OOM。两种稳妥做法（二选一）：

- **A. 临时升配**：控制台把实例临时变配到 **4GiB**（按量计费差价很小），跑一次 `build_nuitka.sh` 编出 `run.bin` 后，再降回 2GiB。二进制编好即可长期以 2GiB 运行。
- **B. 改跑 uvicorn 模式**：不编译，直接 `brass.service` 注释掉二进制行、启用 uvicorn 行。源码在 VPS 上以 `.pyc` 形态运行，SSH 密钥 + 防火墙收紧后安全性等同本机（见 README 五）。

> 二进制模式只是「连云厂商也读不到 .py」的加固；**真正的不泄密底线是：规则引擎不在客户端 + 仓库私有 + CORS 收紧**，这两条与是否二进制无关。

### 8.5 HTTPS（香港地域 certbot 正常签）

香港属于境外，Let's Encrypt 正常签发，无需 ICP 备案：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d brass.你的域名    # 自动签并改写 nginx.brass.conf
```

### 8.6 一键上线清单

1. 领香港 ECS（2C2G）→ 记公网 IP → 安全组放行 22/80/443。
2. DNS：把 `brass.你的域名` A 记录指向公网 IP。
3. 改 `deploy/deploy.sh` 顶部 `VPS_USER` / `VPS_HOST`（填入香港 ECS 的公网 IP 与用户）。
4. 改 `nginx.brass.conf` / `brass.service` 里的 `你的域名` 为真实域名。
5. 本机 `bash deploy/deploy.sh` → 自动同步 + 编译（或按 8.4 升配后编译）+ 启服 + certbot。
6. 好友打开 `https://brass.你的域名?room=房号` 加入。

> 试用到期不续费则实例释放；数据在 VPS 上不自动备份，重要存档请自行 `rsync` 回本机（本项目房间状态在内存，`/opt/brass/*.db` 若有也一并回拉）。
