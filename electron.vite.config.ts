import { resolve } from "path";
import { copyFile, mkdir } from "node:fs/promises";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

/**
 * Copy the Parakeet utility-process child next to the bundled main entry.
 *
 * `electron/parakeetWorker.cjs` is plain CommonJS, forked directly by Electron
 * and deliberately NOT part of the module graph (it `require`s a native addon,
 * which the bundler cannot follow). Rollup would not emit it, so it has to be
 * placed in the output directory explicitly — otherwise `utilityProcess.fork`
 * would resolve to a path that does not exist and fail only at load time.
 *
 * Packaging (asarUnpack) is deliberately untouched: Parakeet is a dev-only
 * comparison engine, so a packaged app never forks this file.
 */
function copyParakeetWorker() {
  return {
    name: "copy-parakeet-worker",
    apply: "build" as const,
    async closeBundle() {
      const from = resolve(__dirname, "electron/parakeetWorker.cjs");
      const outDir = resolve(__dirname, "out/main");
      await mkdir(outDir, { recursive: true });
      await copyFile(from, resolve(outDir, "parakeetWorker.cjs"));
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyParakeetWorker()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "electron/main.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "electron/preload.ts"),
        },
      },
    },
  },
  renderer: {
    root: ".",
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "index.html"),
        },
      },
    },
    plugins: [react()],
  },
});
