#!/usr/bin/env python3
"""
從 flowmusic.app 的 sb-sb-auth-token cookie 解出 Supabase access/refresh token。

用法:
    python scripts/extract_cookie.py            # 從剪貼簿讀取(需 pyperclip)或手動輸入
    python scripts/extract_cookie.py cookie.txt # 從檔案讀取整段 cookie

輸出:
    - access_token / refresh_token 印到畫面
    - 存成 token.txt / refresh_token.txt(供本地 smoke 測試)
"""
import base64
import json
import re
import sys


def decode_cookie(raw: str) -> dict:
    m = re.search(r"sb-sb-auth-token\.0=base64-([A-Za-z0-9+/=]+)", raw)
    if not m:
        raise SystemExit("找不到 sb-sb-auth-token.0 cookie(請確認已貼上完整 Cookie 字串)")
    b64 = m.group(1)
    payload = base64.b64decode(b64 + "=" * (-len(b64) % 4))
    return json.loads(payload)


def main():
    if len(sys.argv) > 1:
        raw = open(sys.argv[1], encoding="utf-8").read()
    else:
        try:
            import pyperclip
            raw = pyperclip.paste()
        except ImportError:
            raw = input("貼上整段 Cookie(或 cookie 檔路徑):").strip()
            if raw and not raw.startswith("_gcl") and len(raw) < 200 and ":" in raw:
                raw = open(raw, encoding="utf-8").read()
    data = decode_cookie(raw)
    user = data.get("user", {})
    print("user:", user.get("email"), "| id:", user.get("id"))
    print("access_token:", data.get("access_token", "")[:25] + "...")
    print("refresh_token:", data.get("refresh_token"))
    # newline="" 避免 Windows 把 \n 轉成 \r\n,導致 token 尾端多出隱藏字元
    open("token.txt", "w", newline="", encoding="utf-8").write(data.get("access_token", ""))
    open("refresh_token.txt", "w", newline="", encoding="utf-8").write(data.get("refresh_token", ""))
    print("已存 token.txt / refresh_token.txt(無尾端換行)")


if __name__ == "__main__":
    main()
