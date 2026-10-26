// サーバー（Worker）のテスト。AI と Google は偽物に差し替える
import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "../src/worker.js";

const HOST = "https://app.example";
const wav = (bytes = 5000) => new Uint8Array(bytes);

function makeEnv(ai) {
  return {
    GOOGLE_CLIENT_ID: "cid",
    GOOGLE_CLIENT_SECRET: "secret",
    ASSETS: { fetch: async () => new Response("<html>", { headers: { "content-type": "text/html" } }) },
    AI: { run: ai },
  };
}

describe("画面の配信", () => {
  it("検索に出さないヘッダーをつける", async () => {
    const res = await worker.fetch(new Request(HOST + "/"), makeEnv());
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });
  it("知らない /api は 404", async () => {
    const res = await worker.fetch(new Request(HOST + "/api/nothing"), makeEnv());
    expect(res.status).toBe(404);
  });
  it("中継は WebSocket 以外を断る", async () => {
    const res = await worker.fetch(new Request(HOST + "/api/room/abcdefghij"), makeEnv());
    expect(res.status).toBe(426);
  });
});

describe("/api/transcribe", () => {
  const post = (headers = {}) => new Request(HOST + "/api/transcribe", { method: "POST", body: wav(), headers });

  it("文字と単語の時間を返す", async () => {
    const ai = vi.fn(async () => ({ text: " こんにちは ", segments: [{ start: 0, end: 1, words: [{ word: "こんにちは", start: 0.123, end: 0.9 }] }] }));
    const res = await worker.fetch(post({ Origin: HOST }), makeEnv(ai));
    expect(await res.json()).toEqual({ text: "こんにちは", words: [["こんにちは", 0.12, 0.9]] });
    expect(ai.mock.calls[0][0]).toBe("@cf/openai/whisper-large-v3-turbo");
    expect(ai.mock.calls[0][1].language).toBe("ja");
  });
  it("無音のときの決まり文句は捨てる", async () => {
    const res = await worker.fetch(post(), makeEnv(async () => ({ text: "ご視聴ありがとうございました" })));
    expect((await res.json()).text).toBe("");
  });
  it("無料分を使い切ったら 429 quota", async () => {
    const res = await worker.fetch(post(), makeEnv(async () => { throw new Error("3036: daily free allocation of 10,000 neurons"); }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("quota");
  });
  it("よそのサイトからは断る", async () => {
    const res = await worker.fetch(post({ Origin: "https://evil.example" }), makeEnv(async () => ({ text: "x" })));
    expect(res.status).toBe(403);
  });
});

describe("/api/diarize", () => {
  it("話者のついた単語だけを返す", async () => {
    const ai = async () => ({ results: { channels: [{ alternatives: [{ words: [
      { start: 0, end: 1, speaker: 0 }, { start: 1, end: 2, speaker: 1 }, { start: 2, end: 3 },
    ] }] }] } });
    const res = await worker.fetch(new Request(HOST + "/api/diarize", { method: "POST", body: wav(100), headers: { "Content-Type": "audio/webm" } }), makeEnv(ai));
    expect((await res.json()).words).toEqual([{ s: 0, e: 1, sp: 0 }, { s: 1, e: 2, sp: 1 }]);
  });
});

describe("Googleログイン", () => {
  let rtValid;
  beforeEach(() => {
    rtValid = true;
    vi.stubGlobal("fetch", async (url, opts) => {
      url = String(url);
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        const p = new URLSearchParams(opts.body);
        if (p.get("grant_type") === "authorization_code") {
          const idToken = "x." + btoa(JSON.stringify({ email: "taro@gmail.com", sub: "123" })).replace(/=+$/, "") + ".y";
          return Response.json({ access_token: "at1", refresh_token: "rt-secret", expires_in: 3599, id_token: idToken });
        }
        return rtValid ? Response.json({ access_token: "at2", expires_in: 3599 }) : Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return new Response("");
    });
  });

  async function login(env) {
    const res = await worker.fetch(new Request(HOST + "/api/auth/login?return=/index.html?room=1"), env);
    const loc = new URL(res.headers.get("Location"));
    const stateCookie = res.headers.get("Set-Cookie").split(";")[0];
    const cb = await worker.fetch(new Request(HOST + "/api/auth/callback?code=abc&state=" + loc.searchParams.get("state"), { headers: { Cookie: stateCookie } }), env);
    return { loc, cb, session: cb.headers.getSetCookie()[0].split(";")[0] };
  }

  it("ログイン → 鍵は暗号化された Cookie に入り、元の場所に戻る", async () => {
    const env = makeEnv();
    const { loc, cb, session } = await login(env);
    expect(loc.searchParams.get("access_type")).toBe("offline");
    expect(loc.searchParams.get("redirect_uri")).toBe(HOST + "/api/auth/callback");
    expect(cb.status).toBe(302);
    expect(cb.headers.get("Location")).toBe("/index.html?room=1");
    expect(session).not.toContain("rt-secret");
    expect(cb.headers.getSetCookie()[0]).toMatch(/HttpOnly; Secure; SameSite=Lax/);
  });
  it("Cookie から短時間用の鍵を作る", async () => {
    const env = makeEnv();
    const { session } = await login(env);
    const res = await worker.fetch(new Request(HOST + "/api/auth/token", { method: "POST", headers: { Cookie: session, Origin: HOST } }), env);
    expect(await res.json()).toEqual({ access_token: "at2", expires_in: 3599, email: "taro@gmail.com" });
  });
  it("にせの Cookie・よそのサイト・違う state は断る", async () => {
    const env = makeEnv();
    const { session } = await login(env);
    expect((await worker.fetch(new Request(HOST + "/api/auth/token", { method: "POST", headers: { Cookie: "mj_session=garbage" } }), env)).status).toBe(401);
    expect((await worker.fetch(new Request(HOST + "/api/auth/token", { method: "POST", headers: { Cookie: session, Origin: "https://evil.example" } }), env)).status).toBe(403);
    expect((await worker.fetch(new Request(HOST + "/api/auth/callback?code=a&state=wrong", { headers: { Cookie: "mj_state=right./" } }), env)).status).toBe(400);
  });
  it("Google 側で鍵が無効になったら Cookie を消す", async () => {
    const env = makeEnv();
    const { session } = await login(env);
    rtValid = false;
    const res = await worker.fetch(new Request(HOST + "/api/auth/token", { method: "POST", headers: { Cookie: session } }), env);
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toMatch(/^mj_session=; .*Max-Age=0/);
  });
  it("秘密の値がないときはログイン機能を閉じる", async () => {
    const env = { ...makeEnv(), GOOGLE_CLIENT_SECRET: "" };
    expect((await worker.fetch(new Request(HOST + "/api/auth/login"), env)).status).toBe(503);
    expect(await (await worker.fetch(new Request(HOST + "/api/config"), env)).json()).toEqual({ googleClientId: "cid", serverLogin: false });
  });
});
