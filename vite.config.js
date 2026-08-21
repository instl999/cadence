import { defineConfig } from 'vite';

export default defineConfig({
  // Electron opens the build through file://, so every asset path must remain relative.
  base: './',
});
