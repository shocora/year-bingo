# Year Bingo

5人で集める「おもしろ探索ビンゴ」の探索ノートです。お題とメンバーから投稿を閲覧し、担当者チップと実際の値を共有・編集できます。

「お題から探す」では各お題の最新投稿と、その値を保持しているメンバー別のマス数を表示します（最高記録の自動判定ではありません）。スマートフォンでもビンゴ全体を把握できる5列表示です。「ボードを編集」では従来の5×5ビンゴで、担当チップの配置・ドラッグ移動・数値の編集を行えます。

## Instagramの投稿記録（スポット収録）

2026年10月2日に `kasubingo_2026` の全69投稿をブラウザで確認し、本文・元の投稿日・記録値・元投稿URLをアプリ内に収録しました。68件を24のお題に分類し、お題一覧の元画像1件は「お題以外・未分類」に含めています。

- お題のカードをタップすると、そのお題の履歴を開きます。メンバーの絞り込みも引き継ぎます。「すべての投稿」では全投稿を閲覧できます。
- お題とメンバーで絞り込めます。値やメンバーが確認できない場合は「未確認」と表示します。
- メンバー対応はユーザー確認済みです：秋田／あきた＝リョウ、廣瀬／ひろせ＝ミッチー、西原／にしはら＝ニッシー、小針＝コバリ、村上＝ムラカミ。名前の記載がなかった18件もユーザーの回答に基づき確定し、全68件の記録にメンバーを設定しています。
- 投稿本文・投稿日・URLの対応は、ブラウザで読み取った全69件と照合済みです。画像だけにあった2048スコア等は確認済みの数値だけを注記付きで保存しています。
- 顔が写る写真をアプリへ残さないため、投稿画像は保存・表示しません。カードから元のInstagram投稿へ移動できます。
- `src/data/instagram-snapshot.json` に投稿データを保存しています。Instagramの埋め込みウィジェットや外部画像URLは使っていません。
- 投稿データの定期取得・自動更新は行いません。次回はブラウザで確認して静的データを更新し、ビルドします。担当チップ・入力値の既存共有機能とは別に管理します。

`npm run test` で投稿データと画像の整合性、絞り込み、投稿日を検証できます。下記の従来のCLI同期は今回の収録には使用していません。

## Web app development

```powershell
npm install
npm run dev
```

Cloudflare Pages FunctionsとD1を含めて確認する場合:

```powershell
npm run build
npm run cf:migrate:local
npx wrangler pages dev dist
```

## Cloudflare Pages

- Build command: `npm run build`
- Build output directory: `dist`
- Production branch: `main`
- D1 binding: `DB` -> `year-bingo-db`

本番反映前にD1マイグレーションを適用します。

```powershell
npm run cf:migrate:remote
```

Cloudflare PagesのProduction環境に次を設定します。

```text
INSTAGRAM_SYNC_TOKEN=<ローカルCLIと共有する十分に長いランダム値>
AUTO_APPLY_MIN_CONFIDENCE=0.72
```

`INSTAGRAM_SYNC_TOKEN`はSecretとして登録してください。生成例:

```powershell
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$token = [Convert]::ToBase64String($bytes)
$rng.Dispose()
$token
```

Cloudflare PagesはGitHubリポジトリを接続し、`main`ブランチへのpushを自動デプロイ対象にします。

## Instagram local sync

Instagramの取得はAWSを使わず、このPCで次の順に実行します。

1. SeleniumがInstagramへログインし、最新投稿を取得
2. Geminiが画像とキャプションからメンバー、マス、値を判定
3. ローカルCLIが共有トークン付きで`/api/instagram-sync`へ判定結果を送信
4. Cloudflare Pages Functionが入力と信頼度を検証してD1を更新
5. 処理済み投稿IDをD1へ保存し、次回のGemini呼び出しを省略

### 初回セットアップ

Python 3.11以降とGoogle Chromeをインストールした状態で実行します。

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements-instagram-sync.txt
```

秘密ではない3項目だけ、実行中のPowerShellへ設定します。

```powershell
$env:INSTAGRAM_USERNAME = "InstagramのIDまたはメール"
$env:INSTAGRAM_PROFILE_URL = "https://www.instagram.com/取得対象ユーザー名/"
$env:BINGO_SITE_BASE_URL = "https://公開中のサイト.pages.dev"
```

### 普段の実行

```powershell
.\.venv\Scripts\Activate.ps1
npm run sync:instagram
```

コマンド実行後、Instagramパスワード、Gemini APIキー、同期トークンを非表示入力します。これらはファイルへ保存されず、ログにも表示されません。無人実行が必要な場合のみ、同名の環境変数`INSTAGRAM_PASSWORD`、`GEMINI_API_KEY`、`INSTAGRAM_SYNC_TOKEN`を設定できます。

判定だけ確認してCloudflareへ反映しない場合:

```powershell
npm run sync:instagram -- --dry-run --visible --max-posts 2
```

Instagramが本人確認を要求する場合:

```powershell
npm run sync:instagram -- --visible
```

Chrome上で確認を完了すると処理を続行します。処理済み投稿も再判定する場合は`--reprocess`を追加します。

## Security and cost

- InstagramパスワードとGemini APIキーはCloudflareやGitHubへ送信しません。
- Cloudflareへ送るのは投稿ID、URL、Geminiの判定結果だけです。投稿画像とキャプションは送信しません。
- 同期APIはBearerトークン必須、本文サイズ256KB以下、1回20件以下に制限しています。
- AWS費用はありません。Cloudflareの無料枠とGeminiの利用量だけを確認すればよい構成です。
- Instagramへ短時間に何度もログインすると制限される可能性があるため、必要なときだけ実行してください。
- チャット等へ一度貼り付けたInstagramパスワードは変更してください。
