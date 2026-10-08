// 文字起こしサイトのサーバー部分（Cloudflare Workers）
// - POST /api/transcribe : 録音した声（WAV）を Cloudflare の AI（Whisper）で文字にする
// - GET  /api/config     : 画面が使う設定（GoogleログインのクライアントID）
// - GET  /api/room/:id   : QRコードでつないだPCとスマホの中継（WebSocket。Durable Object の Room が受け渡す）
// - POST /api/diarize    : 録音全体から「誰が話したか」（話者A・B・C…）を AI（Deepgram Nova-3）で分ける
// - /api/auth/*          : Googleログイン（一度ログインすれば、ページを閉じてもログインしたまま）
// - それ以外             : docs/ の画面をそのまま返す
//
// Cloudflare の無料プランでは、1日の無料分を使い切ると AI がエラーを返すだけで課金はされない。
// そのときは画面側がブラウザの音声認識に自動で切り替える。

const MODEL = "@cf/openai/whisper-large-v3-turbo";
const MAX_BYTES = 2 * 1024 * 1024;

// 無音のときに Whisper が勝手に出しがちな定型文（誤認識）
const HALLUCINATIONS = [
  "ご視聴ありがとうございました",
  "ご清聴ありがとうございました",
  "チャンネル登録",
  "おやすみなさい",
  "最後までご視聴",
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/transcribe") return transcribe(request, env);
    // 画面が使う設定（GoogleログインのID。公開して問題ない値）
    if (url.pathname === "/api/config") {
      return json({ googleClientId: env.GOOGLE_CLIENT_ID || "", serverLogin: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) });
    }
    if (url.pathname === "/api/diarize") return diarize(request, env);
    if (url.pathname.startsWith("/api/auth/")) return auth(request, env, url);
    const room = url.pathname.match(/^\/api\/room\/([a-z0-9]{6,32})$/);
    if (room) {
      if (request.headers.get("Upgrade") !== "websocket") return json({ error: "websocket_required" }, 426);
      return env.ROOMS.get(env.ROOMS.idFromName(room[1])).fetch(request);
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);

    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    out.headers.set("X-Robots-Tag", "noindex, nofollow");
    return out;
  },
};

async function transcribe(request, env) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  // よそのサイトから勝手に使われないように、このサイトの画面からの送信だけ受け付ける
  const origin = request.headers.get("Origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return json({ error: "forbidden" }, 403);

  const audio = new Uint8Array(await request.arrayBuffer());
  if (audio.length < 1000) return json({ text: "" });
  if (audio.length > MAX_BYTES) return json({ error: "too_large" }, 413);

  try {
    const result = await env.AI.run(MODEL, {
      audio: toBase64(audio),
      language: "ja",
      vad_filter: true,
      condition_on_previous_text: false,
    });
    let text = String(result?.text || "").trim();
    if (HALLUCINATIONS.some((h) => text.includes(h)) && text.length < 30) text = "";
    return json({ text });
  } catch (e) {
    const message = String(e?.message || e);
    // 1日の無料分を使い切ったとき（課金はされず、エラーになる）
    const quota = /neuron|allocation|quota|limit|3036/i.test(message);
    return json({ error: quota ? "quota" : "ai_error", message }, quota ? 429 : 502);
  }
}

// ---------------------------------------------------------------- 話者の聞き分け
const DIARIZE_MODEL = "@cf/deepgram/nova-3";
const MAX_DIARIZE_BYTES = 50 * 1024 * 1024;

async function diarize(request, env) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const origin = request.headers.get("Origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return json({ error: "forbidden" }, 403);
  const size = Number(request.headers.get("Content-Length") || 0);
  if (size > MAX_DIARIZE_BYTES) return json({ error: "too_large" }, 413);
  const contentType = (request.headers.get("Content-Type") || "audio/webm").split(";")[0];
  try {
    const result = await env.AI.run(DIARIZE_MODEL, {
      audio: { body: request.body, contentType },
      diarize: true,
      language: "ja",
      punctuate: true,
    });
    const words = result?.results?.channels?.[0]?.alternatives?.[0]?.words || [];
    // 画面で使うのは「何秒から何秒に、何番の人が話したか」だけ
    return json({
      words: words
        .filter((w) => typeof w.speaker === "number")
        .map((w) => ({ s: w.start, e: w.end, sp: w.speaker })),
    });
  } catch (e) {
    const message = String(e?.message || e);
    const quota = /neuron|allocation|quota|limit|3036/i.test(message);
    return json({ error: quota ? "quota" : "ai_error", message }, quota ? 429 : 502);
  }
}

// ---------------------------------------------------------------- Googleログイン（ログインしたままにする）
// Google から受け取った「更新用の鍵（refresh token）」を暗号化して、その端末の Cookie にだけ入れておく。
// サーバーには何も保存しない。ページを開くたびに、その鍵から短時間だけ使える鍵（access token）を作る。
// 暗号化のカギは Cloudflare の秘密の値 GOOGLE_CLIENT_SECRET から作る。
const SCOPE = "openid email https://www.googleapis.com/auth/drive.file";
const SESSION_COOKIE = "mj_session";
const STATE_COOKIE = "mj_state";

async function auth(request, env, url) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return json({ error: "not_configured" }, 503);
  const redirectUri = `${url.origin}/api/auth/callback`;
  const action = url.pathname.slice("/api/auth/".length);

  if (action === "login") {
    const state = randomId();
    const back = safeReturn(url.searchParams.get("return"));
    const google = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    google.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    }).toString();
    return new Response(null, {
      status: 302,
      headers: {
        Location: google.toString(),
        "Set-Cookie": cookie(STATE_COOKIE, `${state}.${encodeURIComponent(back)}`, 600),
      },
    });
  }

  if (action === "callback") {
    const rawState = getCookie(request, STATE_COOKIE) || "";
    const dot = rawState.indexOf(".");
    const state = dot > 0 ? rawState.slice(0, dot) : "";
    const back = dot > 0 ? rawState.slice(dot + 1) : "";
    const home = decodeURIComponent(back || "/");
    if (!state || state !== url.searchParams.get("state")) return page("ログインをやり直してください（時間が経ちすぎたか、別の画面から開かれました）。", home);
    if (url.searchParams.get("error")) return page("Googleログインがキャンセルされました。", home);
    const tokens = await googleToken(env, {
      grant_type: "authorization_code",
      code: url.searchParams.get("code") || "",
      redirect_uri: redirectUri,
    });
    if (!tokens.refresh_token) return page("Googleから必要な許可を受け取れませんでした。もう一度ログインしてください。", home);
    const email = emailFromIdToken(tokens.id_token);
    const session = await encrypt(env, JSON.stringify({ rt: tokens.refresh_token, email }));
    const headers = new Headers({ Location: home });
    headers.append("Set-Cookie", cookie(SESSION_COOKIE, session, 400 * 24 * 3600));
    headers.append("Set-Cookie", cookie(STATE_COOKIE, "", 0));
    return new Response(null, { status: 302, headers });
  }

  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const origin = request.headers.get("Origin");
  if (origin && new URL(origin).host !== url.host) return json({ error: "forbidden" }, 403);
  const raw = getCookie(request, SESSION_COOKIE);
  const session = raw ? await decrypt(env, raw).then(JSON.parse).catch(() => null) : null;

  if (action === "token") {
    if (!session) return json({ error: "not_logged_in" }, 401);
    const tokens = await googleToken(env, { grant_type: "refresh_token", refresh_token: session.rt });
    if (!tokens.access_token) {
      return json({ error: "expired" }, 401, { "Set-Cookie": cookie(SESSION_COOKIE, "", 0) });
    }
    return json({ access_token: tokens.access_token, expires_in: tokens.expires_in, email: session.email });
  }

  if (action === "logout") {
    if (session) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(session.rt)}`, { method: "POST" }).catch(() => {});
    return json({ ok: true }, 200, { "Set-Cookie": cookie(SESSION_COOKIE, "", 0) });
  }
  return json({ error: "not_found" }, 404);
}

async function googleToken(env, params) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...params }),
  });
  return res.json().catch(() => ({}));
}
function emailFromIdToken(idToken) {
  try {
    const part = idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part + "===".slice((part.length + 3) % 4)), (c) => c.charCodeAt(0)))).email || "";
  } catch (_) {
    return "";
  }
}
function safeReturn(path) {
  return path && path.startsWith("/") && !path.startsWith("//") ? path : "/";
}
function randomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}
function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
function getCookie(request, name) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? m[1] : null;
}
async function cryptoKey(env) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.GOOGLE_CLIENT_SECRET), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("mojiokoshi-session"), info: new Uint8Array() },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}
async function encrypt(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cryptoKey(env), new TextEncoder().encode(text)));
  const all = new Uint8Array(iv.length + data.length);
  all.set(iv);
  all.set(data, iv.length);
  return toBase64(all).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function decrypt(env, value) {
  const bin = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4));
  const all = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, await cryptoKey(env), all.slice(12));
  return new TextDecoder().decode(plain);
}
function page(message, back) {
  const safe = message.replace(/[<>&]/g, "");
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ログイン</title><body style="font-family:sans-serif;padding:24px"><p>${safe}</p><p><a href="${back.replace(/"/g, "")}">戻る</a></p>`, {
    status: 400, headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function toBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders },
  });
}

// ---------------------------------------------------------------- PC ⇔ スマホの中継
// 同じ部屋（QRコードのID）につないだ相手に、届いたメッセージをそのまま渡すだけ。何も保存しない。
export class Room {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch() {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    this.broadcast(server, JSON.stringify({ type: "peer-join" }));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    if (message === "ping") return ws.send("pong");  // 接続を保つための合図
    this.broadcast(ws, message);
  }

  webSocketClose(ws) {
    this.broadcast(ws, JSON.stringify({ type: "peer-leave" }));
  }

  webSocketError(ws) {
    this.webSocketClose(ws);
  }

  broadcast(from, message) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === from) continue;
      try { ws.send(message); } catch (_) {}
    }
  }
}
