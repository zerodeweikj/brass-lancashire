#!/usr/bin/env bash
# 在 VPS(Linux) 上执行：把服务端编译成单文件二进制（引擎源码编进二进制，厂商读不到 .py）
# 前置：sudo apt install -y python3-venv python3-dev build-essential
#
# 阿里云香港 ECS 注意：免费档 2 vCPU/2GiB 内存跑 Nuitka 编译可能 OOM。
#   → 编译前到控制台临时变配到 4GiB（差价很小），编出 run.bin 后再降回 2GiB；
#     二进制编好即可长期以 2GiB 运行。
#   → 或放弃二进制、改用 brass.service 的 uvicorn 模式（README 五/8.4）。
set -euo pipefail

DEPLOY=/opt/brass
cd "$DEPLOY"

python3 -m venv venv
# shellcheck disable=SC1091
source venv/bin/activate
pip install -U pip
pip install -r server/requirements.txt
pip install nuitka

# 编译 server/run.py → server/run.bin
#   --include-package=engine,app  把规则引擎与服务端编进二进制（运行时不再需要 .py 源码）
#   BRASS_ROOT=/opt/brass 已在 systemd 环境里设置，运行时据此找 data/ 与 web/public/data/
python3 -m nuitka --onefile \
  --assume-yes-for-downloads \
  --include-package=engine \
  --include-package=app \
  --output-filename=run.bin \
  --output-dir="$DEPLOY/server" \
  server/run.py

echo "✅ 编译完成：$DEPLOY/server/run.bin"
echo "   引擎源码已在二进制内，可删除 server/app/*.py 与 engine/*.py 进一步隐藏（可选）："
echo "   rm -f server/app/*.py engine/*.py engine/**/*.py"
