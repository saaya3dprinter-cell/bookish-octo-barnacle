"""音声文字起こしアプリ（PCマイク / スマホマイク 両対応）

PCで起動すると、2つの入口が開きます。
  - PC用   : http://localhost:8000          （PCのマイクで録音）
  - スマホ用: https://<PCのIP>:8443          （同じWi-Fiのスマホをマイク代わりに使う）

どちらから録音しても、文字起こしはPCの中（faster-whisper）で行われ、
結果はPCの画面と transcripts/ フォルダに保存されます。無料・オフラインで動きます。
"""

import argparse
import datetime as dt
import io
import ipaddress
import queue
import socket
import sys
import threading
import wave
from pathlib import Path

import numpy as np
from flask import Flask, jsonify, request, send_from_directory
from werkzeug.serving import make_server

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
CERT_DIR = BASE_DIR / "cert"
TRANSCRIPT_DIR = BASE_DIR / "transcripts"
SAMPLE_RATE = 16000

# 無音のときに Whisper が勝手に出しがちな定型文（誤認識）を捨てる
HALLUCINATIONS = {
    "ご視聴ありがとうございました",
    "ご視聴ありがとうございました。",
    "ありがとうございました",
    "ありがとうございました。",
    "チャンネル登録よろしくお願いします",
    "おやすみなさい",
}

app = Flask(__name__, static_folder=None)

state = {
    "model": None,
    "model_error": None,
    "entries": [],
    "lang": "ja",
    "lan_ip": "127.0.0.1",
    "https_port": 8443,
}
state_lock = threading.Lock()
jobs: "queue.Queue[tuple[str, np.ndarray]]" = queue.Queue()


# ---------------------------------------------------------------- 文字起こし
def load_model(model_size: str) -> None:
    try:
        from faster_whisper import WhisperModel

        print(f"[モデル] {model_size} を読み込み中...（初回はダウンロードで数分かかります）")
        state["model"] = WhisperModel(model_size, device="auto", compute_type="int8")
        print("[モデル] 準備OK！録音できます。")
    except Exception as e:  # noqa: BLE001
        state["model_error"] = str(e)
        print(f"[モデル] 読み込み失敗: {e}", file=sys.stderr)


def worker() -> None:
    while True:
        source, audio = jobs.get()
        try:
            while state["model"] is None and state["model_error"] is None:
                threading.Event().wait(0.5)
            if state["model"] is None:
                continue
            segments, _ = state["model"].transcribe(
                audio,
                language=state["lang"],
                vad_filter=True,
                beam_size=5,
                condition_on_previous_text=False,
            )
            text = "".join(s.text for s in segments).strip()
            if text and text not in HALLUCINATIONS:
                add_entry(source, text)
        except Exception as e:  # noqa: BLE001
            print(f"[文字起こし] エラー: {e}", file=sys.stderr)
        finally:
            jobs.task_done()


def add_entry(source: str, text: str) -> None:
    now = dt.datetime.now()
    with state_lock:
        entry = {
            "id": len(state["entries"]) + 1,
            "time": now.strftime("%H:%M:%S"),
            "source": source,
            "text": text,
        }
        state["entries"].append(entry)
    TRANSCRIPT_DIR.mkdir(exist_ok=True)
    with open(TRANSCRIPT_DIR / f"{now:%Y-%m-%d}.txt", "a", encoding="utf-8") as f:
        f.write(f"[{entry['time']}] ({source}) {text}\n")
    print(f"[{entry['time']}] ({source}) {text}")


def decode_wav(data: bytes) -> np.ndarray:
    with wave.open(io.BytesIO(data)) as w:
        if w.getsampwidth() != 2:
            raise ValueError("16bit PCM の WAV だけ対応しています")
        rate = w.getframerate()
        channels = w.getnchannels()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    audio = pcm.astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if rate != SAMPLE_RATE and len(audio) > 0:
        n = int(len(audio) * SAMPLE_RATE / rate)
        audio = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio)
    return audio.astype(np.float32)


# ---------------------------------------------------------------- Web API
@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.post("/api/audio")
def upload_audio():
    source = "スマホ" if request.args.get("source") == "phone" else "PC"
    try:
        audio = decode_wav(request.get_data())
    except Exception as e:  # noqa: BLE001
        return jsonify(ok=False, error=str(e)), 400
    if len(audio) < SAMPLE_RATE * 0.3:
        return jsonify(ok=True, skipped=True)
    jobs.put((source, audio))
    return jsonify(ok=True)


@app.get("/api/transcripts")
def transcripts():
    after = request.args.get("after", default=0, type=int)
    with state_lock:
        items = [e for e in state["entries"] if e["id"] > after]
    if state["model_error"]:
        status = f"モデル読み込み失敗: {state['model_error']}"
    elif state["model"] is None:
        status = "モデル準備中…（初回はダウンロードに数分かかります）"
    else:
        status = "準備OK"
    return jsonify(
        entries=items,
        status=status,
        ready=state["model"] is not None,
        pending=jobs.unfinished_tasks,
        phone_url=f"https://{state['lan_ip']}:{state['https_port']}",
    )


# ---------------------------------------------------------------- 起動まわり
def get_lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # 実際には送信しない。経路からIPを調べるだけ
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_cert(lan_ip: str) -> tuple[str, str]:
    """スマホのブラウザでマイクを使うには HTTPS が必須なので、自己署名証明書を作る"""
    cert_path, key_path = CERT_DIR / "cert.pem", CERT_DIR / "key.pem"
    ip_file = CERT_DIR / "ip.txt"
    if cert_path.exists() and key_path.exists() and ip_file.exists() and ip_file.read_text() == lan_ip:
        return str(cert_path), str(key_path)

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "transcriber-local")])
    now = dt.datetime.now(dt.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(days=1))
        .not_valid_after(now + dt.timedelta(days=825))
        .add_extension(
            x509.SubjectAlternativeName(
                [
                    x509.DNSName("localhost"),
                    x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
                    x509.IPAddress(ipaddress.ip_address(lan_ip)),
                ]
            ),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    CERT_DIR.mkdir(exist_ok=True)
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        )
    )
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    ip_file.write_text(lan_ip)
    return str(cert_path), str(key_path)


def print_qr(url: str) -> None:
    try:
        import qrcode

        qr = qrcode.QRCode(border=1)
        qr.add_data(url)
        qr.print_ascii(invert=True)
    except Exception:  # noqa: BLE001
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description="音声文字起こしアプリ")
    parser.add_argument("--model", default="small", help="tiny / base / small / medium / large-v3 （大きいほど高精度で遅い）")
    parser.add_argument("--lang", default="ja", help="言語コード（日本語は ja）")
    parser.add_argument("--port", type=int, default=8000, help="PC用ポート")
    parser.add_argument("--https-port", type=int, default=8443, help="スマホ用ポート")
    args = parser.parse_args()

    lan_ip = get_lan_ip()
    state.update(lang=args.lang, lan_ip=lan_ip, https_port=args.https_port)

    threading.Thread(target=load_model, args=(args.model,), daemon=True).start()
    threading.Thread(target=worker, daemon=True).start()

    cert, key = ensure_cert(lan_ip)
    pc_server = make_server("127.0.0.1", args.port, app, threaded=True)
    phone_server = make_server("0.0.0.0", args.https_port, app, threaded=True, ssl_context=(cert, key))
    threading.Thread(target=pc_server.serve_forever, daemon=True).start()
    threading.Thread(target=phone_server.serve_forever, daemon=True).start()

    phone_url = f"https://{lan_ip}:{args.https_port}"
    print("=" * 60)
    print(f" PCで使う    → ブラウザで  http://localhost:{args.port}")
    print(f" スマホで使う → 同じWi-Fiで {phone_url}")
    print("   （「安全ではありません」と出たら「詳細」→「アクセスする」でOK）")
    print("=" * 60)
    print_qr(phone_url)
    print("終了するには Ctrl + C")

    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        print("\n終了します")
        pc_server.shutdown()
        phone_server.shutdown()


if __name__ == "__main__":
    main()
