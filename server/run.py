# -*- coding: utf-8 -*-
"""生产入口：被 Nuitka 编译成二进制，或直接 `python server/run.py` 运行。

端口/地址按环境自适应：
  - 本地开发：127.0.0.1:8765（前面由 nginx 反代，见 deploy/nginx.brass.conf）
  - Render 等 PaaS：注入了 PORT 环境变量 → 自动监听 0.0.0.0:$PORT
数据目录通过环境变量 BRASS_ROOT 指定（见 engine/data.py），默认按文件位置推导。
"""
import os
import uvicorn


def main():
    # 多玩家并发由 FastAPI 异步处理；单 worker 即可，长轮询不会阻塞。
    # 注意：workers>1 会 spawn 子进程，打包成二进制或在 PaaS 上都可能出问题，保持 1。
    port = int(os.environ.get('BRASS_PORT') or os.environ.get('PORT') or 8765)
    # PORT 是 PaaS（Render/Heroku 等）注入的标志，此时必须监听 0.0.0.0 才能被外部访问。
    default_host = '0.0.0.0' if os.environ.get('PORT') else '127.0.0.1'
    uvicorn.run(
        'app.main:app',
        host=os.environ.get('BRASS_HOST', default_host),
        port=port,
        workers=int(os.environ.get('BRASS_WORKERS', '1')),
        log_level=os.environ.get('BRASS_LOG', 'info'),
    )


if __name__ == '__main__':
    main()
