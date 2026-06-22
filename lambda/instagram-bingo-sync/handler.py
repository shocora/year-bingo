from __future__ import annotations

import base64
import json
import os
import re
import shutil
import time
import uuid
from dataclasses import dataclass
from typing import Any

import requests
from selenium import webdriver
from selenium.common.exceptions import TimeoutException
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

os.environ.setdefault("HOME", "/tmp")
os.environ.setdefault("XDG_CACHE_HOME", "/tmp/.cache")
os.environ.setdefault("SE_CACHE_PATH", "/tmp/selenium-cache")

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


@dataclass(frozen=True)
class InstagramPost:
    post_id: str
    permalink: str
    caption: str
    screenshot_png: bytes


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    try:
        verify_request(event)
        body = parse_body(event)
        max_posts = max(1, min(20, int(body.get("maxPosts") or os.environ.get("MAX_MEDIA_PER_RUN", DEFAULT_MAX_POSTS))))
        processed_post_ids = parse_processed_post_ids(body.get("processedPostIds"))

        crawler = InstagramCrawler(env_required("INSTAGRAM_USERNAME"), env_required("INSTAGRAM_PASSWORD"))
        try:
            crawler.login()
            posts = crawler.collect_recent_posts(env_required("INSTAGRAM_PROFILE_URL"), max_posts)
        finally:
            crawler.close()

        api_key = env_required("GEMINI_API_KEY")
        model = os.environ.get("GEMINI_MODEL", DEFAULT_MODEL)
        results = []
        errors = []

        for post in posts:
            if post.post_id in processed_post_ids:
                results.append(
                    {
                        "postId": post.post_id,
                        "permalink": post.permalink,
                        "caption": post.caption,
                        "skipped": "alreadyProcessed",
                    }
                )
                continue

            try:
                results.append(
                    {
                        "postId": post.post_id,
                        "permalink": post.permalink,
                        "caption": post.caption,
                        "classification": classify_post(api_key, model, post),
                    }
                )
            except Exception as exc:  # noqa: BLE001 - return per-post error for CloudWatch and caller
                errors.append(f"{post.post_id}: {exc}")
                results.append(
                    {
                        "postId": post.post_id,
                        "permalink": post.permalink,
                        "caption": post.caption,
                        "error": str(exc),
                    }
                )

        return json_response({"status": "success", "postsSeen": len(posts), "results": results, "errors": errors})
    except PermissionError as exc:
        return json_response({"status": "error", "postsSeen": 0, "results": [], "errors": [str(exc)]}, 401)
    except Exception as exc:  # noqa: BLE001 - Lambda Function URL should return JSON errors
        return json_response({"status": "error", "postsSeen": 0, "results": [], "errors": [str(exc)]}, 500)


class InstagramCrawler:
    def __init__(self, username: str, password: str):
        run_id = str(uuid.uuid4())
        self.chrome_temp_dirs = (
            f"/tmp/chrome-user-data-{run_id}",
            f"/tmp/chrome-data-{run_id}",
            f"/tmp/chrome-cache-{run_id}",
        )
        self.driver = webdriver.Chrome(options=build_chrome_options(self.chrome_temp_dirs))
        self.wait_seconds = int(os.environ.get("INSTAGRAM_WAIT_SECONDS", "25"))
        self.wait = WebDriverWait(self.driver, self.wait_seconds)
        self.username = username
        self.password = password

    def close(self) -> None:
        try:
            self.driver.quit()
        finally:
            for path in self.chrome_temp_dirs:
                shutil.rmtree(path, ignore_errors=True)

    def login(self) -> None:
        self.driver.get("https://www.instagram.com/accounts/login/")
        username_input = self.wait.until(EC.element_to_be_clickable((By.NAME, "username")))
        password_input = self.wait.until(EC.element_to_be_clickable((By.NAME, "password")))
        username_input.clear()
        username_input.send_keys(self.username)
        password_input.clear()
        password_input.send_keys(self.password)
        password_input.send_keys(Keys.ENTER)

        for _ in range(int(os.environ.get("INSTAGRAM_LOGIN_MAX_STEPS", "4"))):
            time.sleep(float(os.environ.get("INSTAGRAM_LOGIN_STEP_WAIT_SECONDS", "4")))
            if "accounts/login" not in self.driver.current_url and not self.has_login_form():
                dismiss_optional_dialogs(self.driver)
                return
            if self.has_verification_challenge():
                raise RuntimeError("Instagram requested 2FA or a login challenge")

        raise RuntimeError("Instagram login did not complete")

    def has_login_form(self) -> bool:
        return bool(self.driver.find_elements(By.NAME, "username"))

    def has_verification_challenge(self) -> bool:
        challenge_selectors = (
            "input[name='verificationCode']",
            "input[name='security_code']",
            "input[autocomplete='one-time-code']",
        )
        return any(self.driver.find_elements(By.CSS_SELECTOR, selector) for selector in challenge_selectors)

    def collect_recent_posts(self, profile_url: str, max_posts: int) -> list[InstagramPost]:
        self.driver.get(profile_url)
        self.wait.until(EC.presence_of_element_located((By.TAG_NAME, "article")))

        post_urls: list[str] = []
        seen: set[str] = set()

        for _ in range(8):
            anchors = self.driver.find_elements(By.CSS_SELECTOR, "a[href*='/p/'], a[href*='/reel/']")
            for anchor in anchors:
                href = normalize_instagram_url(anchor.get_attribute("href") or "")
                if href and href not in seen:
                    seen.add(href)
                    post_urls.append(href)
                    if len(post_urls) >= max_posts:
                        break
            if len(post_urls) >= max_posts:
                break
            self.driver.execute_script("window.scrollTo(0, document.body.scrollHeight)")
            time.sleep(float(os.environ.get("INSTAGRAM_SCROLL_WAIT_SECONDS", "1.2")))

        return [self.read_post(url) for url in post_urls[:max_posts]]

    def read_post(self, url: str) -> InstagramPost:
        self.driver.get(url)
        article = self.wait.until(EC.presence_of_element_located((By.TAG_NAME, "article")))
        time.sleep(0.8)
        caption = first_text(self.driver, ("article h1", "article span[dir='auto']", "main article"))
        screenshot = article.screenshot_as_png or self.driver.get_screenshot_as_png()
        return InstagramPost(post_id=post_id_from_url(url), permalink=url, caption=caption, screenshot_png=screenshot)


def build_chrome_options(chrome_temp_dirs: tuple[str, str, str]) -> Options:
    user_data_dir, data_path, cache_dir = chrome_temp_dirs
    options = Options()
    options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-setuid-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-gpu")
    options.add_argument("--disable-software-rasterizer")
    options.add_argument("--disable-extensions")
    options.add_argument("--disable-background-networking")
    options.add_argument("--disable-sync")
    options.add_argument("--disable-default-apps")
    options.add_argument("--disable-popup-blocking")
    options.add_argument("--disable-notifications")
    options.add_argument("--no-first-run")
    options.add_argument("--no-zygote")
    options.add_argument("--hide-scrollbars")
    options.add_argument("--window-size=1280,1800")
    options.add_argument("--remote-debugging-pipe")
    options.add_argument(f"--user-data-dir={user_data_dir}")
    options.add_argument(f"--data-path={data_path}")
    options.add_argument(f"--disk-cache-dir={cache_dir}")

    chrome_binary = os.environ.get("CHROME_BINARY")
    if chrome_binary:
        options.binary_location = chrome_binary

    return options


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
    response = requests.post(
        endpoint,
        params={"key": api_key},
        json=payload,
        timeout=int(os.environ.get("GEMINI_TIMEOUT_SECONDS", "60")),
    )
    if not response.ok:
        raise RuntimeError(f"Gemini API failed: {response.status_code} {response.text[:500]}")
    text = extract_gemini_text(response.json())
    return normalize_classification(json.loads(text))


def classification_prompt(post: InstagramPost) -> str:
    return "\n".join(
        [
            "Instagram投稿のスクリーンショットとキャプションから、ビンゴのどのマスを誰がどんな値で埋めたかを判定してください。",
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


def dismiss_optional_dialogs(driver: webdriver.Chrome) -> None:
    for _ in range(3):
        try:
            button = WebDriverWait(driver, 3).until(
                EC.element_to_be_clickable(
                    (
                        By.XPATH,
                        "//button[contains(., '後で') or contains(., 'Not Now') or contains(., '今はしない') or contains(., '後にする')]",
                    )
                )
            )
            button.click()
        except TimeoutException:
            return


def first_text(driver: webdriver.Chrome, selectors: tuple[str, ...]) -> str:
    for selector in selectors:
        for element in driver.find_elements(By.CSS_SELECTOR, selector):
            text = clean_text(element.text)
            if text:
                return text
    return ""


def verify_request(event: dict[str, Any]) -> None:
    expected = env_required("SYNC_TOKEN")
    headers = {str(key).lower(): value for key, value in (event.get("headers") or {}).items()}
    bearer = str(headers.get("authorization") or "")
    if not bearer.lower().startswith("bearer ") or bearer[7:] != expected:
        raise PermissionError("Unauthorized")


def parse_body(event: dict[str, Any]) -> dict[str, Any]:
    body = event.get("body")
    if not body:
        return {}
    if event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode("utf-8")
    if isinstance(body, str):
        return json.loads(body)
    return body if isinstance(body, dict) else {}


def parse_processed_post_ids(value: Any) -> set[str]:
    if not isinstance(value, list):
        return set()
    return {post_id for item in value if isinstance(item, str) and (post_id := clean_text(item))}


def json_response(body: dict[str, Any], status_code: int = 200) -> dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
        },
        "body": json.dumps(body, ensure_ascii=False),
    }


def normalize_instagram_url(value: str) -> str:
    match = re.search(r"https://www\.instagram\.com/(?:p|reel)/[^/?#]+", value)
    return match.group(0) + "/" if match else ""


def post_id_from_url(value: str) -> str:
    match = re.search(r"instagram\.com/((?:p|reel)/[^/?#]+)/?", value)
    return match.group(1) if match else value


def clean_text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+", " ", value).strip()


def clean_value(value: Any) -> str:
    return clean_text(value)[:32]


def env_required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value
