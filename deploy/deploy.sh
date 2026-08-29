#!/usr/bin/env bash
# 在本机(Windows Git-Bash)执行：把项目同步到 VPS 并以 uvicorn 模式启服（免 Nuitka 编译）。
# 采用 SSH 密钥登录（一次性把公钥推上去），不再用 ControlMaster 多路复用——
# 阿里云网关对多路复用通道支持不好，会 Connection reset by peer。
# 前置：Windows 10+ 自带 OpenSSH（Git-Bash 里直接用 ssh 即可）。
set -euo pipefail

# ===== 按你的 VPS 实际情况修改 =====
VPS_USER=root              # 阿里云 Alibaba Cloud Linux 3 默认 root；若镜像为 Ubuntu 改 ubuntu
VPS_HOST=47.76.136.173     # 你的 ECS 公网 IP
# ================================

DEPLOY=/opt/brass
LOCAL=/d/zhuoyou/lancashire
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=$HOME/.ssh/known_hosts -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=3"

echo "==> 确保本地有 SSH 密钥（无口令，便于免密登录）"
if [ ! -f "$HOME/.ssh/id_ed25519" ]; then
  mkdir -p "$HOME/.ssh"
  ssh-keygen -t ed25519 -N '' -f "$HOME/.ssh/id_ed25519"
fi

echo "==> 检查是否已有密钥登录；没有则推一次公钥（会要一次 ECS 实例密码）"
if ! ssh $SSH_OPTS -o BatchMode=yes "$VPS_USER@$VPS_HOST" "true" 2>/dev/null; then
  echo "    尚未配置密钥，推送公钥（输入密码后以后就免密了）"
  cat "$HOME/.ssh/id_ed25519.pub" \
    | ssh $SSH_OPTS "$VPS_USER@$VPS_HOST" "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
else
  echo "    已可密钥登录，跳过"
fi

echo "==> 1/2 打包并上传代码到 $DEPLOY"
ssh $SSH_OPTS "$VPS_USER@$VPS_HOST" "mkdir -p $DEPLOY"
tar -czf - \
  --exclude '.venv' --exclude 'node_modules' --exclude '__pycache__' \
  --exclude '*.pyc' --exclude '*.db' --exclude '*.db.bak' --exclude 'uvicorn*.log' \
  --exclude '.git' \
  -C "$LOCAL" . \
  | ssh $SSH_OPTS "$VPS_USER@$VPS_HOST" "tar -xzf - -C $DEPLOY"

echo "==> 2/2 在 VPS 上安装依赖并启服（uvicorn 模式，免编译）"
ssh $SSH_OPTS "$VPS_USER@$VPS_HOST" "bash $DEPLOY/deploy/on_vps_setup.sh"

echo "✅ 完成。浏览器打开 http://$VPS_HOST 即可异地联机。"
