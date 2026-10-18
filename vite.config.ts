import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3000,
    host: '0.0.0.0'
  },
  build: {
    // The Firebase SDK alone is ~590 kB minified (~140 kB gzip) and cannot be split further.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // Split big libraries out of the app code: smaller files, and the browser can keep the
        // library files cached when only the app changes.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/firebase/') || id.includes('/@firebase/')) return 'firebase';
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) return 'react';
          if (id.includes('/lucide-react/')) return 'icons';
          return 'vendor';
        },
      },
    },
  },
});
