"""Update Year Bingo from recent Instagram posts on this computer."""

from __future__ import annotations

import argparse
import base64
import getpass
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

MEMBERS = [
    {"id": "ryo", "name": "リョウ"},
    {"id": "murakami", "name": "ムラカミ"},
    {"id": "kobari", "name": "コバリ"},
    {"id": "mitchy", "name": "ミッチー"},
    {"id": "nissy", "name": "ニッシー"},
]

CELLS = [
    {"id": "discount", "title": "最大割引率"},
    {"id": "gasoline", "title": "最安ガソリン価格"},
    {"id": "south", "title": "到達した最南端地点"},
    {"id": "same-drink", "title": "自販機の同一飲料本数"},
    {"id": "ramen", "title": "最高額ラーメン"},
    {"id": "future-expiry", "title": "最も未来の賞味期限"},
    {"id": "locker", "title": "最大ロッカー番号"},
    {"id": "temperature", "title": "最高気温"},
    {"id": "gamble", "title": "公営ギャンブル最高勝ち額"},
    {"id": "street-number", "title": "街中で見つけた最大の数字"},
    {"id": "bill-number", "title": "お札に書かれた最大数字"},
    {"id": "first-train", "title": "最も早い電車の発車時刻"},
    {"id": "steps", "title": "1日の最大歩数"},
    {"id": "old-expiry", "title": "最も古い賞味期限"},
    {"id": "altitude", "title": "到達した最大標高"},
    {"id": "vending-price", "title": "自販機の最大飲料価格"},
    {"id": "score-2048", "title": "2048 最高スコア"},
    {"id": "north", "title": "到達した最北端地点"},
    {"id": "calorie", "title": "最高カロリー食品"},
    {"id": "real-estate", "title": "不動産チラシ最高額"},
    {"id": "vending-row", "title": "自販機の最大並び台数"},
    {"id": "convenience", "title": "コンビニでの最高支払額"},
    {"id": "cats", "title": "同時に見た野生ねこの数"},
    {"id": "wait", "title": "最大待ち時間"},
    {"id": "coin", "title": "最も古い硬貨"},
]

MEMBER_IDS = {member["id"] for member in MEMBERS}
CELL_IDS = {cell["id"] for cell in CELLS}
DEFAULT_MODEL = "gemini-2.5-flash-lite"
DEFAULT_MAX_POSTS = 8
API_TIMEOUT_SECONDS = 60
DEBUG_DIR = Path("artifacts/instagram-sync")

@dataclass(frozen=True)
class InstagramPost:
    post_id: str
    permalink: str
    caption: str
    screenshot_png: bytes

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Instagramの最新投稿を解析し、Year Bingoを更新します。"
    )
    parser.add_argument("--dry-run", action="store_true", help="Cloudflareへ反映せず判定結果だけ表示")
    parser.add_argument("--visible", action="store_true", help="Chromeを表示して実行")
    parser.add_argument("--reprocess", action="store_true", help="処理済み投稿も再判定")
    parser.add_argument("--max-posts", type=int, default=int_env("MAX_MEDIA_PER_RUN", DEFAULT_MAX_POSTS))
    parser.add_argument("--site-url", help="公開中のビンゴサイトURL")
    parser.add_argument("--profile-url", help="取得対象のInstagramプロフィールURL")
    args = parser.parse_args()
    load_selenium()

    max_posts = max(1, min(20, args.max_posts))
    username = setting("INSTAGRAM_USERNAME", "Instagram IDまたはメール: ")
    password = setting("INSTAGRAM_PASSWORD", "Instagramパスワード: ", secret=True)
    profile_url = args.profile_url or setting("INSTAGRAM_PROFILE_URL", "対象プロフィールURL: ")
    gemini_api_key = setting("GEMINI_API_KEY", "Gemini APIキー: ", secret=True)
    model = os.environ.get("GEMINI_MODEL", DEFAULT_MODEL)

    site_url = ""
    sync_token = ""
    processed_post_ids: set[str] = set()

    if not args.dry_run:
        site_url = (args.site_url or setting("BINGO_SITE_BASE_URL", "ビンゴサイトURL: ")).rstrip("/")
        sync_token = setting("INSTAGRAM_SYNC_TOKEN", "同期トークン: ", secret=True)
        if not args.reprocess:
            processed_post_ids = fetch_processed_post_ids(site_url, sync_token)

    driver = create_driver(headless=not args.visible)
    results: list[dict[str, Any]] = []
    post_urls: list[str] = []

    try:
        print("Instagramにログインしています...")
        login(driver, username, password, interactive=args.visible)
        post_urls = collect_recent_post_urls(driver, profile_url, max_posts, interactive=args.visible)
        print(f"最新投稿を{len(post_urls)}件確認しました。")

        new_urls = [
            url for url in post_urls
            if args.reprocess or post_id_from_url(url) not in processed_post_ids
        ]
        print(f"未処理の{len(new_urls)}件を解析します。")

        for index, url in enumerate(new_urls, start=1):
            post_id = post_id_from_url(url)
            print(f"[{index}/{len(new_urls)}] {url}")
            try:
                post = read_post(driver, url, interactive=args.visible)
                classification = classify_post(gemini_api_key, model, post)
                result = {
                    "postId": post.post_id,
                    "permalink": post.permalink,
                    "classification": classification,
                }
                results.append(result)
                print(json.dumps(classification, ensure_ascii=False))
            except Exception as exc:  # Continue so one malformed post does not block the run.
                results.append({"postId": post_id, "permalink": url, "error": str(exc)})
                print(f"  解析失敗: {exc}", file=sys.stderr)
    except Exception:
        if args.visible:
            wait_before_closing_browser()
        raise
    finally:
        driver.quit()

    if args.dry_run:
        print(json.dumps({"status": "dry-run", "postsSeen": len(post_urls), "results": results}, ensure_ascii=False, indent=2))
        return 0 if not any("error" in result for result in results) else 1

    summary = submit_results(site_url, sync_token, len(post_urls), results, args.reprocess)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if summary.get("status") == "success" and not summary.get("errors") else 1

def load_selenium() -> None:
    try:
        from selenium import webdriver as selenium_webdriver
        from selenium.common.exceptions import TimeoutException as SeleniumTimeoutException
        from selenium.webdriver import ChromeOptions as SeleniumChromeOptions
        from selenium.webdriver.common.by import By as SeleniumBy
        from selenium.webdriver.common.keys import Keys as SeleniumKeys
        from selenium.webdriver.support import expected_conditions as SeleniumEC
        from selenium.webdriver.support.ui import WebDriverWait as SeleniumWebDriverWait
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "Seleniumが未導入です。python -m pip install -r requirements-instagram-sync.txt を実行してください。"
        ) from exc

    globals().update(
        {
            "webdriver": selenium_webdriver,
            "TimeoutException": SeleniumTimeoutException,
            "ChromeOptions": SeleniumChromeOptions,
            "By": SeleniumBy,
            "Keys": SeleniumKeys,
            "EC": SeleniumEC,
            "WebDriverWait": SeleniumWebDriverWait,
        }
    )


def create_driver(headless: bool) -> webdriver.Chrome:
    options = ChromeOptions()
    if headless:
        options.add_argument("--headless=new")
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-notifications")
    options.add_argument("--lang=ja-JP")
    options.add_argument("--no-sandbox")
    options.add_argument("--window-size=1280,1800")
    return webdriver.Chrome(options=options)

def login(driver: webdriver.Chrome, username: str, password: str, interactive: bool) -> None:
    driver.get("https://www.instagram.com/accounts/login/")
    dismiss_optional_dialogs(driver)
    submitted_credentials = False

    while not is_authenticated(driver):
        wait_until_or_manual(
            driver,
            lambda current: is_authenticated(current)
            or has_verification_challenge(current)
            or has_manual_action_message(current)
            or has_login_error_message(current)
            or find_login_inputs(current),
            "Instagramログイン画面または確認画面",
            "login-wait",
            interactive,
        )

        if is_authenticated(driver):
            break

        if has_login_error_message(driver):
            request_manual_recovery(
                driver,
                interactive,
                "Instagramログインに失敗した可能性があります。ID、パスワード、本人確認要求をChromeで確認してください。",
                "login-error",
            )
            submitted_credentials = False
            continue

        if has_verification_challenge(driver) or has_manual_action_message(driver):
            request_manual_recovery(
                driver,
                interactive,
                "InstagramがreCAPTCHAまたは本人確認を要求しています。Chromeで完了してください。",
                "login-manual-action",
            )
            continue

        inputs = find_login_inputs(driver)
        if inputs and not submitted_credentials:
            username_input, password_input = inputs
            username_input.clear()
            username_input.send_keys(username)
            password_input.clear()
            password_input.send_keys(password)
            password_input.send_keys(Keys.ENTER)
            submitted_credentials = True
            continue

        request_manual_recovery(
            driver,
            interactive,
            "Instagramログインの続きを自動判定できませんでした。Chromeで必要な操作を完了してください。",
            "login-unknown",
        )

    dismiss_optional_dialogs(driver)

def login_finished(driver: webdriver.Chrome) -> bool:
    return is_authenticated(driver)

def is_authenticated(driver: webdriver.Chrome) -> bool:
    try:
        return any(cookie.get("name") == "sessionid" and cookie.get("value") for cookie in driver.get_cookies())
    except Exception:
        return False

def find_login_inputs(driver: webdriver.Chrome):
    username_selectors = (
        "input[name='username']",
        "input[name='email']",
        "input[autocomplete*='username']",
        "input[aria-label*='電話']",
        "input[aria-label*='Phone']",
        "input[aria-label*='email']",
        "input[aria-label*='メール']",
    )
    password_selectors = (
        "input[name='password']",
        "input[name='pass']",
        "input[type='password']",
        "input[autocomplete='current-password']",
    )
    username_input = first_enabled_element(driver, username_selectors)
    password_input = first_enabled_element(driver, password_selectors)
    return (username_input, password_input) if username_input and password_input else None

def first_enabled_element(driver: webdriver.Chrome, selectors: tuple[str, ...]):
    for selector in selectors:
        for element in driver.find_elements(By.CSS_SELECTOR, selector):
            if element.is_displayed() and element.is_enabled():
                return element
    return None

def has_verification_challenge(driver: webdriver.Chrome) -> bool:
    selectors = (
        "input[name='verificationCode']",
        "input[name='security_code']",
        "input[autocomplete='one-time-code']",
    )
    return any(driver.find_elements(By.CSS_SELECTOR, selector) for selector in selectors)

def has_login_error_message(driver: webdriver.Chrome) -> bool:
    page_text = body_text(driver)
    error_markers = (
        "パスワードが正しくありません",
        "問題が発生しました",
        "ログインできませんでした",
        "incorrect",
        "try again",
        "challenge_required",
    )
    return any(marker.lower() in page_text.lower() for marker in error_markers)

def has_manual_action_message(driver: webdriver.Chrome) -> bool:
    page_text = body_text(driver).lower()
    markers = (
        "本人確認",
        "私はロボットではありません",
        "認証コード",
        "セキュリティコード",
        "セキュリティチェック",
        "アカウントにアクセス",
        "しばらくしてから",
        "recaptcha",
        "suspicious",
        "challenge",
        "verification",
        "security code",
        "try again later",
    )
    return any(marker.lower() in page_text for marker in markers)

def body_text(driver: webdriver.Chrome) -> str:
    try:
        return clean_text(driver.find_element(By.TAG_NAME, "body").text)
    except Exception:
        return ""

def body_excerpt(driver: webdriver.Chrome, max_length: int = 220) -> str:
    text = body_text(driver)
    return text[:max_length] if text else "(本文なし)"

def wait_until_or_manual(
    driver: webdriver.Chrome,
    condition,
    description: str,
    snapshot_label: str,
    interactive: bool,
    timeout: int | None = None,
):
    wait_seconds = timeout if timeout is not None else int_env("INSTAGRAM_WAIT_SECONDS", 30)
    while True:
        try:
            return WebDriverWait(driver, wait_seconds).until(condition)
        except TimeoutException:
            request_manual_recovery(
                driver,
                interactive,
                f"{description}を確認できませんでした。Chromeで必要な操作を完了してください。",
                snapshot_label,
            )

def request_manual_recovery(driver: webdriver.Chrome, interactive: bool, message: str, snapshot_label: str) -> None:
    snapshot = save_debug_snapshot(driver, snapshot_label)
    details = f"{message}\n現在URL: {driver.current_url}\n画面テキスト: {body_excerpt(driver)}\nデバッグ保存先: {snapshot}"

    if not interactive or not sys.stdin.isatty():
        raise RuntimeError(details + "\n--visibleで再実行すると手動操作で続行できます。")

    print(details)
    input("Chromeで操作を完了したら、PowerShellに戻ってEnterを押してください...")

def wait_before_closing_browser() -> None:
    if not sys.stdin.isatty():
        return
    try:
        input("エラーが発生しました。Chromeを確認できます。閉じるにはEnterを押してください...")
    except EOFError:
        return

def dismiss_optional_dialogs(driver: webdriver.Chrome) -> None:
    for _ in range(3):
        try:
            button = WebDriverWait(driver, 3).until(
                EC.element_to_be_clickable(
                    (
                        By.XPATH,
                        "//button[contains(., '後で') or contains(., 'Not Now') or contains(., '今はしない') or contains(., '後にする') or contains(., 'Allow all') or contains(., 'すべて許可') or contains(., '許可する')]",
                    )
                )
            )
            button.click()
        except TimeoutException:
            return

def save_debug_snapshot(driver: webdriver.Chrome, label: str) -> str:
    DEBUG_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    base = DEBUG_DIR / f"{timestamp}-{label}"
    png_path = base.with_suffix(".png")
    html_path = base.with_suffix(".html")

    try:
        driver.save_screenshot(str(png_path))
    except Exception:
        png_path = Path("")

    try:
        html_path.write_text(driver.page_source, encoding="utf-8")
    except Exception:
        html_path = Path("")

    saved = [str(path) for path in (png_path, html_path) if path]
    return ", ".join(saved) if saved else str(DEBUG_DIR)

def collect_recent_post_urls(driver: webdriver.Chrome, profile_url: str, max_posts: int, interactive: bool) -> list[str]:
    driver.get(profile_url)
    while True:
        wait_until_or_manual(
            driver,
            lambda current: current.find_elements(By.CSS_SELECTOR, "a[href*='/p/'], a[href*='/reel/']")
            or current.find_elements(By.TAG_NAME, "article")
            or find_login_inputs(current)
            or has_manual_action_message(current),
            "Instagramプロフィールページの投稿一覧",
            "profile-timeout",
            interactive,
        )

        if find_login_inputs(driver):
            request_manual_recovery(
                driver,
                interactive,
                "プロフィール表示時にログイン画面へ戻されました。Chromeでログインを完了してください。",
                "profile-login-required",
            )
            continue

        if has_manual_action_message(driver):
            request_manual_recovery(
                driver,
                interactive,
                "Instagram側で手動確認が必要な画面が表示されています。Chromeで確認を完了してください。",
                "profile-manual-action",
            )
            continue

        post_urls: list[str] = []
        seen: set[str] = set()

        for _ in range(8):
            anchors = driver.find_elements(By.CSS_SELECTOR, "a[href*='/p/'], a[href*='/reel/']")
            for anchor in anchors:
                href = normalize_instagram_url(anchor.get_attribute("href") or "")
                if href and href not in seen:
                    seen.add(href)
                    post_urls.append(href)
                    if len(post_urls) >= max_posts:
                        break
            if len(post_urls) >= max_posts:
                break
            driver.execute_script("window.scrollTo(0, document.body.scrollHeight)")
            time.sleep(float_env("INSTAGRAM_SCROLL_WAIT_SECONDS", 1.2))

        if post_urls:
            return post_urls[:max_posts]

        request_manual_recovery(
            driver,
            interactive,
            "プロフィールから投稿URLを取得できませんでした。対象プロフィールURLや表示状態をChromeで確認してください。",
            "profile-no-posts",
        )

def read_post(driver: webdriver.Chrome, url: str, interactive: bool) -> InstagramPost:
    driver.get(url)
    article = wait_until_or_manual(
        driver,
        lambda current: current.find_elements(By.TAG_NAME, "article"),
        "Instagram投稿ページの本文",
        "post-timeout",
        interactive,
    )[0]
    time.sleep(0.8)
    caption = first_text(driver, ("article h1", "article span[dir='auto']", "main article"))
    screenshot = article.screenshot_as_png or driver.get_screenshot_as_png()
    return InstagramPost(
        post_id=post_id_from_url(url),
        permalink=url,
        caption=caption,
        screenshot_png=screenshot,
    )

def classify_post(api_key: str, model: str, post: InstagramPost) -> dict[str, Any]:
    endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"text": classification_prompt(post)},
                    {
                        "inlineData": {
                            "mimeType": "image/png",
                            "data": base64.b64encode(post.screenshot_png).decode("ascii"),
                        }
                    },
                ],
            }
        ],
        "generationConfig": {
            "temperature": 0,
            "responseMimeType": "application/json",
            "responseSchema": classification_schema(),
        },
    }
    status, response_payload = request_json(
        endpoint + "?" + urllib.parse.urlencode({"key": api_key}),
        method="POST",
        payload=payload,
        timeout=int_env("GEMINI_TIMEOUT_SECONDS", API_TIMEOUT_SECONDS),
    )
    if status >= 400:
        detail = json.dumps(response_payload, ensure_ascii=False)[:500]
        raise RuntimeError(f"Gemini API failed: {status} {detail}")
    return normalize_classification(json.loads(extract_gemini_text(response_payload)))

def classification_prompt(post: InstagramPost) -> str:
    return "\n".join(
        [
            "Instagram投稿の画像とキャプションから、ビンゴのどのマスを誰がどんな値で埋めたかを判定してください。",
            "明確に判断できない場合は shouldUpdate=false にしてください。",
            "memberId は次から選択: " + ", ".join(f"{member['id']}={member['name']}" for member in MEMBERS),
            "cellId は次から選択: " + ", ".join(f"{cell['id']}={cell['title']}" for cell in CELLS),
            "value は画面に表示する短い値だけにしてください。例や説明文は不要です。",
            "postUrl: " + post.permalink,
            "caption:",
            post.caption,
        ]
    )

def classification_schema() -> dict[str, Any]:
    return {
        "type": "OBJECT",
        "properties": {
            "shouldUpdate": {"type": "BOOLEAN"},
            "memberId": {
                "type": "STRING",
                "nullable": True,
                "enum": [member["id"] for member in MEMBERS],
            },
            "cellId": {
                "type": "STRING",
                "nullable": True,
                "enum": [cell["id"] for cell in CELLS],
            },
            "value": {"type": "STRING"},
            "confidence": {"type": "NUMBER"},
            "evidence": {"type": "STRING"},
        },
        "required": ["shouldUpdate", "memberId", "cellId", "value", "confidence", "evidence"],
    }

def normalize_classification(value: dict[str, Any]) -> dict[str, Any]:
    member_id = value.get("memberId") if value.get("memberId") in MEMBER_IDS else None
    cell_id = value.get("cellId") if value.get("cellId") in CELL_IDS else None
    confidence = value.get("confidence") if isinstance(value.get("confidence"), (int, float)) else 0
    return {
        "shouldUpdate": value.get("shouldUpdate") is True,
        "memberId": member_id,
        "cellId": cell_id,
        "value": clean_value(value.get("value")),
        "confidence": max(0, min(1, float(confidence))),
        "evidence": clean_text(value.get("evidence")),
    }

def extract_gemini_text(payload: dict[str, Any]) -> str:
    if payload.get("promptFeedback"):
        feedback = json.dumps(payload["promptFeedback"], ensure_ascii=False)
        raise RuntimeError(f"Gemini prompt was blocked or rejected: {feedback}")

    for candidate in payload.get("candidates", []):
        for part in candidate.get("content", {}).get("parts", []):
            text = part.get("text")
            if isinstance(text, str) and text.strip():
                return text
    raise RuntimeError("Gemini response did not include text")

def fetch_processed_post_ids(site_url: str, token: str) -> set[str]:
    status, payload = request_json(
        f"{site_url}/api/instagram-sync",
        bearer_token=token,
        timeout=API_TIMEOUT_SECONDS,
    )
    if status >= 400:
        raise RuntimeError(f"処理済み投稿の取得に失敗しました: {status} {payload}")
    values = payload.get("processedPostIds", [])
    return {value for value in values if isinstance(value, str)} if isinstance(values, list) else set()


def submit_results(
    site_url: str,
    token: str,
    posts_seen: int,
    results: list[dict[str, Any]],
    reprocess: bool,
) -> dict[str, Any]:
    status, payload = request_json(
        f"{site_url}/api/instagram-sync",
        method="POST",
        payload={"postsSeen": posts_seen, "reprocess": reprocess, "results": results},
        bearer_token=token,
        timeout=API_TIMEOUT_SECONDS,
    )
    if status >= 400:
        raise RuntimeError(f"ビンゴの更新に失敗しました: {status} {payload}")
    return payload


def request_json(
    url: str,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    bearer_token: str | None = None,
    timeout: int = API_TIMEOUT_SECONDS,
) -> tuple[int, dict[str, Any]]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"accept": "application/json"}
    if payload is not None:
        headers["content-type"] = "application/json"
    if bearer_token:
        headers["authorization"] = f"Bearer {bearer_token}"

    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, parse_json_body(response.read())
    except urllib.error.HTTPError as error:
        return error.code, parse_json_body(error.read())
    except urllib.error.URLError as error:
        raise RuntimeError(f"HTTP通信に失敗しました: {error.reason}") from error


def parse_json_body(body: bytes) -> dict[str, Any]:
    text = body.decode("utf-8", errors="replace")
    try:
        value = json.loads(text)
        return value if isinstance(value, dict) else {"response": value}
    except json.JSONDecodeError:
        return {"response": text[:1000]}

def first_text(driver: webdriver.Chrome, selectors: tuple[str, ...]) -> str:
    for selector in selectors:
        for element in driver.find_elements(By.CSS_SELECTOR, selector):
            text = clean_text(element.text)
            if text:
                return text
    return ""

def normalize_instagram_url(value: str) -> str:
    post_path = instagram_post_path(value)
    return f"https://www.instagram.com/{post_path}/" if post_path else ""

def post_id_from_url(value: str) -> str:
    return instagram_post_path(value) or value

def instagram_post_path(value: str) -> str:
    """Extract a canonical p/<id> or reel/<id> path from current Instagram URLs.

    Instagram may prefix links in profile grids with the account name, e.g.
    /kasubingo_2026/p/ABC123/. Selenium returns that form for the current web UI.
    """
    path = urllib.parse.urlparse(value).path
    segments = [segment for segment in path.split("/") if segment]
    for index, segment in enumerate(segments[:-1]):
        if segment in {"p", "reel"}:
            post_key = segments[index + 1]
            if post_key:
                return f"{segment}/{post_key}"
    return ""

def clean_text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+", " ", value).strip()

def clean_value(value: Any) -> str:
    return clean_text(value)[:32]

def setting(name: str, prompt: str, secret: bool = False) -> str:
    value = os.environ.get(name, "")
    if value:
        return value if secret else value.strip()
    if not sys.stdin.isatty():
        raise RuntimeError(f"環境変数 {name} が必要です。")
    value = getpass.getpass(prompt) if secret else input(prompt)
    if not value:
        raise RuntimeError(f"{name} は空にできません。")
    return value if secret else value.strip()

def int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default

def float_env(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\n中断しました。", file=sys.stderr)
        raise SystemExit(130)
    except Exception as exc:
        print(f"エラー: {exc}", file=sys.stderr)
        raise SystemExit(1)
