# Year Bingo

5人で使う「おもしろ探索ビンゴ」の担当者チップ共有ページです。iPhoneで開き、各マスにメンバーのチップと実際の値を表示・編集できます。

## Local development

```powershell
npm install
npm run dev
```

Cloudflare Pages Functions と D1 を含めて確認する場合:

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

Apply the remote migration before production use:

```powershell
npm run cf:migrate:remote
```

Cloudflare Pages の production 環境に以下を登録してください。

```text
INSTAGRAM_SYNC_LAMBDA_URL=https://<lambda-function-url>/
INSTAGRAM_SYNC_TOKEN=<LambdaのSYNC_TOKENと同じ共有トークン>
AUTO_APPLY_MIN_CONFIDENCE=0.72
MAX_MEDIA_PER_RUN=8
INSTAGRAM_SYNC_COOLDOWN_SECONDS=300
```

`INSTAGRAM_SYNC_TOKEN` は Pages の secret として登録してください。`.dev.vars*` と `.env*` は git にコミットしない設定です。

## GitHub deployment

Cloudflare Pages は GitHub リポジトリを接続し、`main` ブランチへの push を自動デプロイ対象にします。Pages 側のビルド設定は上記の `npm run build` / `dist` です。

Lambda コンテナは `.github/workflows/deploy-instagram-sync.yml` で更新できます。初回だけ AWS 側に Lambda 関数と実行ロールを作ってから、GitHub Secrets に以下を登録してください。

```text
AWS_ROLE_TO_ASSUME=arn:aws:iam::<account-id>:role/<github-actions-deploy-role>
AWS_REGION=ap-northeast-1
ECR_REPOSITORY=year-bingo-instagram-sync
LAMBDA_FUNCTION_NAME=year-bingo-instagram-sync
```

Lambda 実行時の `INSTAGRAM_USERNAME` / `INSTAGRAM_PASSWORD` / `GEMINI_API_KEY` / `SYNC_TOKEN` は GitHub Actions ではなく、AWS Lambda の環境変数に登録します。

## Instagram sync architecture

アプリ上の「インスタ更新」ボタンを押すと、次の流れで投稿を取り込みます。

1. Cloudflare Pages Function `/api/instagram-sync` がボタン押下を受ける
2. Pages Function が AWS Lambda Function URL を共有トークン付きで呼び出す
3. Lambda コンテナが Selenium + Chromium で Instagram にログインし、最近の投稿画像とキャプションを取得する
4. Gemini が「誰が、どのマスを、どんな値で埋めたか」をJSONで判定する
5. Pages Function が信頼度しきい値以上の結果だけ D1 の `bingo_state` に反映する
6. 取り込み済み投稿は `instagram_processed_posts` に保存し、同じ投稿の二重反映を避ける

Lambda 側の実装は `lambda/instagram-bingo-sync` にあります。

Required Lambda environment variables:

```text
INSTAGRAM_USERNAME=<Instagramのユーザー名またはメール>
INSTAGRAM_PASSWORD=<Instagramのパスワード>
INSTAGRAM_PROFILE_URL=https://www.instagram.com/<対象ユーザー名>/
GEMINI_API_KEY=<Gemini API key>
SYNC_TOKEN=<Cloudflare PagesのINSTAGRAM_SYNC_TOKENと同じ値>
```

Optional Lambda environment variables:

```text
GEMINI_MODEL=gemini-2.5-flash-lite
MAX_MEDIA_PER_RUN=8
INSTAGRAM_WAIT_SECONDS=25
INSTAGRAM_LOGIN_MAX_STEPS=4
INSTAGRAM_SCROLL_WAIT_SECONDS=1.2
GEMINI_TIMEOUT_SECONDS=60
```

## Lambda container

`warikan_app_taiki_hinako` の Lambda コンテナ構成と同じ方向で、Python slim + Chromium + chromedriver + `awslambdaric` を使います。

```powershell
cd lambda/instagram-bingo-sync
docker build -t year-bingo-instagram-sync:local .
```

ローカルでLambdaハンドラだけ確認する例:

```powershell
docker run --rm --entrypoint python `
  -e INSTAGRAM_USERNAME `
  -e INSTAGRAM_PASSWORD `
  -e INSTAGRAM_PROFILE_URL `
  -e GEMINI_API_KEY `
  -e SYNC_TOKEN `
  year-bingo-instagram-sync:local `
  -c "import handler, json, os; event={'headers': {'authorization': 'Bearer ' + os.environ['SYNC_TOKEN']}, 'body': '{\"maxPosts\": 2}'}; print(json.dumps(handler.handler(event, None), ensure_ascii=False, indent=2))"
```

本番では ECR にイメージを push し、Lambda Function URL を作成して、そのURLを Cloudflare Pages の `INSTAGRAM_SYNC_LAMBDA_URL` に設定します。詳しいコマンド例は `lambda/instagram-bingo-sync/README.md` を参照してください。

## Notes

- Instagram のID/Pass、Gemini API key、共有トークンはコードに書かず、AWS Lambda と Cloudflare Pages の Secrets/環境変数で扱います。
- Instagram が2段階認証やログインチャレンジを要求した場合、Lambdaは安全側で失敗します。
- 無料枠に収める前提で、同期はボタン押下時のみ実行し、Cloudflare側で短いクールダウンを入れています。
