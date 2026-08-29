import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
    // 不预先清空 dist：本机 AI 沙箱的 fs 删除被安全 shim 拦截（批量删除需确认），
    // 改为只覆盖写新产物；index.html 始终引用最新 hash，残留旧包无害。
    emptyOutDir: false,
  },
});
