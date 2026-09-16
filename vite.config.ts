import {defineConfig} from 'vite';
export default defineConfig({build:{rollupOptions:{output:{manualChunks:{terminal:['@xterm/xterm','@xterm/addon-fit','@xterm/addon-web-links']}}}}});
