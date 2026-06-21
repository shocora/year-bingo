# Year Bingo

5人で使う「おもしろ探索ビンゴ」の担当者チップ共有ページです。

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

## Cloudflare

- Build command: `npm run build`
- Build output directory: `dist`
- Production branch: `main`
- D1 binding: `DB` -> `year-bingo-db`

Apply the remote migration before production use:

```powershell
npm run cf:migrate:remote
```

## Instagram auto sync

Instagram の投稿を 15 分ごとに確認し、投稿画像とキャプションから「誰が」「どのマスを」「どんな値で」埋めたかを判定して D1 の `bingo_state` を更新する Worker です。Instagram のログインメールやパスワードは使わず、Meta の公式 API トークンと OpenAI API キーを Cloudflare Secrets として扱います。

GitHub Actions から自動デプロイする場合は、GitHub repository secrets に `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_USER_ID`, `OPENAI_API_KEY`, `RUN_TOKEN` を登録してください。`main` へ push すると migration 適用後に Worker がデプロイされます。

手元から設定・デプロイする場合:

```powershell
npm run cf:migrate:remote
npx wrangler secret put INSTAGRAM_ACCESS_TOKEN --config wrangler.instagram-sync.toml
npx wrangler secret put INSTAGRAM_USER_ID --config wrangler.instagram-sync.toml
npx wrangler secret put OPENAI_API_KEY --config wrangler.instagram-sync.toml
npx wrangler secret put RUN_TOKEN --config wrangler.instagram-sync.toml
npm run cf:instagram:deploy
```

任意で Meta Webhooks を使う場合は、以下も secret に登録します。Webhook は `/instagram/webhook` で verification challenge と `x-hub-signature-256` の検証に対応しています。

```powershell
npx wrangler secret put META_WEBHOOK_VERIFY_TOKEN --config wrangler.instagram-sync.toml
npx wrangler secret put META_APP_SECRET --config wrangler.instagram-sync.toml
```

手動実行は `RUN_TOKEN` を Bearer token として渡します。

```powershell
curl.exe -H "Authorization: Bearer <RUN_TOKEN>" https://year-bingo-instagram-sync.<your-subdomain>.workers.dev/run
```

ローカル確認用の secret は `.dev.vars` に置けますが、`.dev.vars*` と `.env*` は git にコミットしないでください。
