import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  mode: "production",
  plugins: [tsconfigPaths()],
  build: {
    target: "esnext",
    minify: "esbuild",
    sourcemap: false,
  },
  resolve: {
    conditions: ["production", "default"],
  },
  optimizeDeps: {
    exclude: ["react-router"],
  },
});
