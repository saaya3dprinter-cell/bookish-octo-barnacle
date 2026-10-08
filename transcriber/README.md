# 🎙 音声文字起こしアプリ（PC / スマホ マイク両対応）

無料・オフラインで動く文字起こしアプリです（AI: [faster-whisper](https://github.com/SYSTRAN/faster-whisper)、MITライセンスで商用OK）。

- **PCにマイクがある** → PCのブラウザで録音
- **PCにマイクがない** → 同じWi-Fiのスマホをマイク代わりに使い、PCへ送信

どちらで録音しても、文字起こしは **PCの中** で行い、結果はPCの画面と `transcripts/日付.txt` に保存されます。

## 起動方法（Windows）

1. Python 3.10 以上を入れておく
2. `start.bat` をダブルクリック（初回は自動でインストール。AIモデルのダウンロードで数分かかります）
3. 黒い画面に出たアドレスを開く

| 使い方 | 開くアドレス |
|---|---|
| PCのマイクで録音 | PCのブラウザで `http://localhost:8000` |
| スマホのマイクで録音 | スマホで `https://<PCのIP>:8443`（黒い画面のQRコードを読み取ってもOK） |

> スマホで「この接続ではプライバシーが保護されません」と出たら、「詳細設定」→「アクセスする」で進めてください（PCの中だけで使う自作の証明書なので問題ありません）。

## VS Code / コマンドで起動する場合

```bash
pip install -r requirements.txt
python app.py              # 標準（small モデル）
python app.py --model medium   # もっと高精度（遅くなる）
python app.py --model base     # 速さ優先
```

## うまくいかないとき

- **スマホがつながらない**: PCとスマホが同じWi-Fiか確認。Windowsのファイアウォールで「Python」の通信を許可してください（初回起動時に出るダイアログで「許可」）。
- **遅い**: `--model base` にする。NVIDIA の GPU があると自動で速くなります。
- **関係ない文が出る**: 無音のときに出る誤認識は自動で一部除外しています。気になる文があれば `app.py` の `HALLUCINATIONS` に追加してください。
