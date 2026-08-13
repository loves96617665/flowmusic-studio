/**
 * 雙層驗證:
 *   1. 呼叫者 → API Key(env API_KEYS,逗號分隔;Authorization: Bearer <key>)
 *   2. 上游   → flowmusic access token(Supabase JWT,由 refresh token 自動續期)
 *
 * Token 策略(無 KV):
 *   Supabase 每次 refresh 都會輪替 refresh token。這裡**只重用 env 裡同一個
 *   FLOWMUSIC_REFRESH_TOKEN、不消耗輪替後的繼任者**,只要沒有其他東西推進
 *   token 鏈(例如同時在瀏覽器登入 flowmusic.app 並讓 session 刷新),token 就
 *   長期有效;失效時錯誤訊息會明說,回 Vercel Dashboard 貼新的即可。
 */

const SUPABASE_URL = "https://sb.flowmusic.app";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVkbmpjY3FjbWJ4ZWF4YmlkaW5yIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1NjEwNjQsImV4cCI6MjA4NzEzNzA2NH0." +
  "XCXSuL7Th1xHecfRrP0vAOFmKwJxwBqVFLu06SxtVzg";

let cachedAccess = null; // { token, expiresAt }

/**
 * 驗證呼叫者的 API Key。
 * 回傳 { ok: true } 或 { ok: false, reason: "missing_header" | "not_configured" | "mismatch" }。
 */
export function checkApiKey(request, env) {
  const header = request.headers.get("Authorization") || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!provided) return { ok: false, reason: "missing_header" };
  const keys = (env.API_KEYS || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (!keys.length) return { ok: false, reason: "not_configured" };
  return keys.includes(provided) ? { ok: true } : { ok: false, reason: "mismatch" };
}

/** 對 env 的 refresh token 執行一次 Supabase refresh,回傳新的 access token。 */
async function refreshAccessToken(env) {
  const refreshToken = env.FLOWMUSIC_REFRESH_TOKEN || null;
  if (!refreshToken) {
    // 沒有 refresh token 時,退回靜態 access token(短效,約 1 小時)
    if (env.FLOWMUSIC_ACCESS_TOKEN) {
      cachedAccess = { token: env.FLOWMUSIC_ACCESS_TOKEN, expiresAt: 0 };
      return env.FLOWMUSIC_ACCESS_TOKEN;
    }
    throw new Error(
      "No FLOWMUSIC_REFRESH_TOKEN / FLOWMUSIC_ACCESS_TOKEN configured. " +
        "Set FLOWMUSIC_REFRESH_TOKEN in Vercel dashboard → Project → Settings → " +
        "Environment Variables (check Production) → Redeploy. " +
        "Get the value: python scripts/extract_cookie.py cookie.txt"
    );
  }

  const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: {
      apikey: ANON_KEY,
      Authorization: "Bearer " + ANON_KEY,
      "Content-Type": "application/json",
      "X-Client-Info": "gotrue-js/2.84.0",
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const text = await resp.text().catch(() => "");
  if (!resp.ok) {
    // refresh_token 被用過/輪替失效 → 需要重新登入拿新 token
    if (/refresh_token_already_used|invalid.*refresh|token.*expired/i.test(text)) {
      throw new Error(
        "FLOWMUSIC_REFRESH_TOKEN invalid/expired (Supabase rotates tokens on use). " +
          "Re-login to flowmusic.app, copy the fresh sb-sb-auth-token.0 cookie, run " +
          "'python scripts/extract_cookie.py cookie.txt' to get the refresh_token, then " +
          "update it in the Vercel dashboard (Settings → Environment Variables) and Redeploy."
      );
    }
    throw new Error(`Token refresh failed (${resp.status}): ${text.slice(0, 200)}`);
  }
  const data = JSON.parse(text);
  if (!data.access_token) throw new Error("Token refresh returned no access_token");

  cachedAccess = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000 - 60_000, // 提前 1 分鐘刷新
  };
  // 注意:刻意不保存 data.refresh_token(輪替後的繼任者)——重用策略,避免推進 token 鏈
  return data.access_token;
}

/** 取得目前有效的 flowmusic access token(記憶體快取 + 到期自動續期)。 */
export async function getAccessToken(env) {
  if (cachedAccess && cachedAccess.expiresAt > Date.now()) return cachedAccess.token;
  return await refreshAccessToken(env);
}

/** 產生帶 Authorization 的上游請求 headers */
export async function upstreamHeaders(env, extra = {}) {
  const token = await getAccessToken(env);
  return {
    Authorization: "Bearer " + token,
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "flowmusic-studio/0.1",
    ...extra,
  };
}
