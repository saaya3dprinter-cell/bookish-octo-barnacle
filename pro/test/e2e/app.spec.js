// 今ある機能が、コピーした有料版でも同じように動くことの確認
import { test, expect } from "@playwright/test";
import { mockApis, freshStart } from "./helpers.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

test("録音すると文字が出て、一覧に残る", async ({ page }) => {
  await mockApis(page, { texts: ["今日は花瓶の打ち合わせです", "高さは20センチ"] });
  await freshStart(page);
  await expect(page.locator("#homeView")).toBeVisible();
  await page.click("#homeNew");                       // 新しく録音する → すぐ録音開始
  await expect(page.locator("#rec")).toContainText("停止");
  await page.waitForTimeout(16500);                    // テスト用の音は鳴り続けるので 15 秒で区切られる
  await page.click("#rec");
  await expect(page.locator("#done")).toContainText("今日は花瓶の打ち合わせです");
  await expect(page.locator("#audioList")).toContainText("録音1");
  await expect(page.locator("#saveState")).toContainText("未保存");
  await page.click("#saveDoc");
  await expect(page.locator("#saveState")).toContainText("保存済み");
  await page.click("#homeBtn");
  await expect(page.locator(".docCard")).toHaveCount(1);
  await expect(page.locator(".docCard .preview")).toContainText("今日は花瓶");
});

test("⋯メニューから Word を出力すると、話者名つきで時刻なし", async ({ page }) => {
  await mockApis(page);
  await page.route(/docx@9\.5\.1/, (r) => r.fulfill({ path: path.resolve("node_modules/docx/dist/index.iife.js"), contentType: "text/javascript" }));
  await freshStart(page, { folders: [], audios: [], currentId: "d1", docs: [{ id: "d1", name: "打ち合わせ", folderId: "", createdAt: 1, updatedAt: 1,
    entries: [{ time: "10:00:00", source: "PC", text: "こんにちは", speaker: "A", speakerName: "田中" }, { time: "10:00:05", source: "PC", text: "どうも" }] }] });
  await page.locator(".docCard").first().click();
  await page.click("#moreBtn");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator("#popMenu .menuItem", { hasText: "Word" }).click()]);
  const file = path.join(os.tmpdir(), "mj-test.docx");
  await dl.saveAs(file);
  const xml = await unzipDocument(file);
  expect(xml).toContain("田中：");
  expect(xml).toContain("こんにちは");
  expect(xml).not.toContain("10:00:00");
});

test("話者の印からメニューで話者・名前を変えられる", async ({ page }) => {
  await mockApis(page);
  page.on("dialog", (d) => d.accept("佐藤"));
  await freshStart(page, { folders: [], audios: [], currentId: "d1", docs: [{ id: "d1", name: "打ち合わせ", folderId: "", createdAt: 1, updatedAt: 1,
    entries: [{ time: "10:00:00", source: "PC", text: "こんにちは" }, { time: "10:00:05", source: "PC", text: "どうも" }] }] });
  await page.locator(".docCard").first().click();
  const tag = (i) => page.locator("#transcript .tag").nth(i);
  await tag(1).click();
  await page.locator("#popMenu .menuItem", { hasText: "新しい人" }).click();
  await expect(tag(1)).toHaveText("A ▾");
  await tag(1).click();
  await page.locator("#popMenu .menuItem", { hasText: "名前を変える" }).click();
  await expect(tag(1)).toHaveText("佐藤 ▾");
});

test("音声ファイルから文字起こしできる", async ({ page }) => {
  await mockApis(page, { texts: ["前半", "後半"] });
  await freshStart(page);
  await page.setInputFiles("#importFile", { name: "meeting.wav", mimeType: "audio/wav", buffer: makeWav(30) });
  await expect(page.locator("#docName")).toHaveValue("meeting");
  await expect(page.locator("#done")).toContainText("前半");
  await expect(page.locator("#done")).toContainText("後半");
  await expect(page.locator("#audioList")).toContainText("録音1");
});

test("QRでつないだスマホの声が PC に届き、スマホで録音も聞ける", async ({ browser }) => {
  const pcCtx = await browser.newContext();
  const pc = await pcCtx.newPage();
  await mockApis(pc);
  await freshStart(pc, { folders: [], audios: [], currentId: "d1", docs: [{ id: "d1", name: "花瓶の打ち合わせ", folderId: "", createdAt: 1, updatedAt: 1, entries: [{ time: "9:00:00", source: "PC", text: "前の内容" }] }] });
  await pc.locator(".docCard").first().click();
  const link = await pc.locator("#phoneLink").textContent();

  const phoneCtx = await browser.newContext({ userAgent: "Mozilla/5.0 (Linux; Android 14) Mobile", viewport: { width: 390, height: 844 } });
  const phone = await phoneCtx.newPage();
  await mockApis(phone, { texts: ["スマホの声"] });
  await phone.goto(link);
  await expect(phone.locator("#docName")).toHaveValue("💻 PCの「花瓶の打ち合わせ」に送っています");
  await phone.click("#rec");
  await phone.waitForTimeout(16500);
  await phone.click("#rec");
  await expect(pc.locator("#done")).toContainText("スマホの声");
  await expect(pc.locator("#audioList")).toContainText("録音1");
  await expect(phone.locator("#audioList")).toContainText("録音1");
  await phone.locator("#audioList button", { hasText: "聞く" }).click();
  await expect(phone.locator("#audioList audio")).toHaveCount(1);
  await pcCtx.close();
  await phoneCtx.close();
});

// --- テスト用の道具
function makeWav(seconds) {
  const rate = 16000, n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const on = Math.floor(t) % 7 !== 6;  // 7秒ごとに1秒の無音
    buf.writeInt16LE(on ? Math.round(8000 * Math.sin(2 * Math.PI * 220 * t)) : 0, 44 + i * 2);
  }
  return buf;
}
async function unzipDocument(file) {
  const { execFileSync } = await import("node:child_process");
  return execFileSync("unzip", ["-p", file, "word/document.xml"]).toString();
}
