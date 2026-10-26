# 文字起こし（有料版）

今のサイト（リポジトリ直下・`mojiokoshi.saaya3dprint.com`）をコピーして作った、有料で配布するための版です。
今のサイトとは **別の Worker（`mojiokoshi-pro`）・別のアドレス（`app.saaya3dprint.com`）** で動きます。

## フォルダの中身
| 場所 | 内容 |
|---|---|
| `public/index.html` | 画面の骨組み |
| `public/styles.css` | 見た目 |
| `public/app.js` | 画面の動き（録音・文字起こし・保存・話者・出力など） |
| `public/privacy.html` | プライバシーポリシー |
| `src/worker.js` | サーバー（AI の呼び出し、Google ログイン、PC⇔スマホの中継） |
| `test/worker.test.js` | サーバーのテスト（vitest） |
| `test/e2e/*.spec.js` | 画面のテスト（Playwright。AI と Google は偽物に差し替え） |

## テストの動かし方
```bash
cd pro
npm install
npm test                 # サーバーのテスト
npm run test:e2e         # 画面のテスト（ローカルで wrangler dev が立ち上がります）
```

## Cloudflare への置き方（最初の1回）
1. Cloudflare の **Workers & Pages → Create application → Import a repository** で、このリポジトリを選ぶ
2. 設定
   - Project name：`mojiokoshi-pro`
   - **Root directory（Path）：`pro`**
   - Build command：空欄 / Deploy command：`npx wrangler deploy`
   - Production branch：使うブランチ
3. Deploy すると `app.saaya3dprint.com` が自動でつく（`wrangler.jsonc` の `routes`）
4. **Settings → Variables and Secrets** に Secret を追加
   - `GOOGLE_CLIENT_SECRET`（今のサイトと同じ値）
5. Google Cloud の「クライアント」に追加
   - 承認済みの JavaScript 生成元：`https://app.saaya3dprint.com`
   - 承認済みのリダイレクト URI：`https://app.saaya3dprint.com/api/auth/callback`

## 環境変数・秘密の値（段階が進むごとに増えます）
| 名前 | 種類 | 内容 |
|---|---|---|
| `GOOGLE_CLIENT_ID` | 変数（`wrangler.jsonc`） | Google OAuth クライアント ID（今のサイトと同じ） |
| `GOOGLE_CLIENT_SECRET` | Secret | Google OAuth クライアントシークレット。ログインの Cookie の暗号化にも使う |
