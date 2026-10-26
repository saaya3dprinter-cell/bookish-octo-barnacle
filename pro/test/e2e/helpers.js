// テスト用の偽物（AI・QRコードのライブラリ）
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));

export async function mockApis(page, { texts = ["こんにちは"], words = null, diarize = null } = {}) {
  let n = 0;
  await page.route(/qrcode\.js$/, (r) => r.fulfill({ path: path.join(here, "../../node_modules/qrcode-generator/qrcode.js"), contentType: "text/javascript" }));
  await page.route(/\/api\/transcribe$/, (r) => {
    const i = n++;
    r.fulfill({ contentType: "application/json", body: JSON.stringify({ text: texts[i % texts.length], words: words ? words[i % words.length] : undefined }) });
  });
  await page.route(/\/api\/diarize$/, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ words: diarize || [] }) }));
  return { count: () => n };
}

export async function freshStart(page, library) {
  await page.goto("/");
  await page.evaluate((lib) => {
    localStorage.clear();
    if (lib) localStorage.setItem("mojiokoshi-library-v1", JSON.stringify(lib));
  }, library || null);
  await page.reload();
}
