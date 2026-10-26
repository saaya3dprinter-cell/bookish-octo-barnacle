// 画面のテスト。ローカルの wrangler dev（AI なし）を立ち上げ、AI と Google は各テストで偽物に差し替える
import { defineConfig } from "@playwright/test";

const PORT = 8788;
export default defineConfig({
  testDir: "test/e2e",
  timeout: 120_000,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || undefined,
      // 本物のマイクの代わりにテスト用の音を使う
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
  },
  webServer: {
    command: `npx wrangler dev --config wrangler.test.jsonc --port ${PORT} --ip 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
