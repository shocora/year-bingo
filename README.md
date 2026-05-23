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
