// 文字起こしサイトのサーバー部分（Cloudflare Workers）
// - POST /api/transcribe : 録音した声（WAV）を Cloudflare の AI（Whisper）で文字にする
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

function toBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
