# Instagram bingo sync Lambda

Selenium で Instagram にログインし、最近の投稿を Gemini で分類して Cloudflare Pages Function へ返す Lambda コンテナです。D1 の更新・処理済み管理は Cloudflare 側の `/api/instagram-sync` が行います。

## Required environment variables

- `INSTAGRAM_USERNAME`
- `INSTAGRAM_PASSWORD`
- `INSTAGRAM_PROFILE_URL`
- `GEMINI_API_KEY`
- `SYNC_TOKEN`: Cloudflare Pages Function からの呼び出しを検証する共有トークン

Optional:

- `GEMINI_MODEL`: default `gemini-2.5-flash-lite`
- `MAX_MEDIA_PER_RUN`: default `8`
- `INSTAGRAM_WAIT_SECONDS`: default `25`
- `INSTAGRAM_LOGIN_MAX_STEPS`: default `4`
- `INSTAGRAM_SCROLL_WAIT_SECONDS`: default `1.2`

## Local dry run

```sh
docker build -t year-bingo-instagram-sync:local .

docker run --rm --entrypoint python \
  -e INSTAGRAM_USERNAME \
  -e INSTAGRAM_PASSWORD \
  -e INSTAGRAM_PROFILE_URL \
  -e GEMINI_API_KEY \
  -e SYNC_TOKEN \
  year-bingo-instagram-sync:local \
  -c "import handler, json, os; event={'headers': {'authorization': 'Bearer ' + os.environ['SYNC_TOKEN']}, 'body': '{\"maxPosts\": 2}'}; print(json.dumps(handler.handler(event, None), ensure_ascii=False, indent=2))"
```

## Deploy outline

```sh
cd lambda/instagram-bingo-sync

AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
AWS_REGION="ap-northeast-1"
REPOSITORY="year-bingo-instagram-sync"
IMAGE_URI="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$REPOSITORY:latest"

aws ecr create-repository --repository-name "$REPOSITORY" --region "$AWS_REGION"
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

docker buildx build --platform linux/amd64 -t "$IMAGE_URI" .
docker push "$IMAGE_URI"

aws lambda create-function \
  --function-name year-bingo-instagram-sync \
  --package-type Image \
  --code ImageUri="$IMAGE_URI" \
  --role "arn:aws:iam::$AWS_ACCOUNT_ID:role/YOUR_LAMBDA_EXECUTION_ROLE" \
  --timeout 300 \
  --memory-size 1024 \
  --region "$AWS_REGION"
```

Function URL は `AWS_IAM` ではなく共有トークンで守る場合、`NONE` にして `SYNC_TOKEN` を必ず設定してください。Cloudflare Pages 側にも同じ値を `INSTAGRAM_SYNC_TOKEN` として登録します。
