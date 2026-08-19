import { defineConfig } from 'vite';

export default defineConfig({
  // Electron 通过 file:// 打开构建产物，所有资源都必须使用相对路径。
  base: './',
});
