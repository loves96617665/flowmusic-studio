/**
 * 雙層驗證:
 *   1. 呼叫者 → API Key(env API_KEYS,逗號分隔;Authorization: Bearer <key>)
 *   2. 上游   → flowmusic access token(Supabase JWT,由 refresh token 自動續期)
 *
 * Supabase refresh token 每次使用後會輪替,新值存進 KV(FLOWMUSIC_KV),避免一小時後失效。
 */

const SUPABASE_URL = "https://sb.flowmusic.app";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVkbmpjY3FjbWJ4ZWF4YmlkaW5yIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1NjEwNjQsImV4cCI6MjA4NzEzNzA2NH0." +
  "XCXSuL7Th1xHecfRrP0vAOFmKwJxwBqVFLu06SxtVzg";

export const KV_REFRESH_KEY = "flowmusic_refresh_token";
const KV_ACCESS_KEY = "flowmusic_access_token";

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

/** 對單一 refresh token 執行一次 Supabase refresh,回傳 { accessToken, rotatedRefreshToken }。 */
async function doRefresh(refreshToken) {
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
    const err = new Error(`Token refresh failed (${resp.status}): ${text.slice(0, 200)}`);
    err.status = resp.status;
    err.body = text;
    throw err;
  }
  const data = JSON.parse(text);
  if (!data.access_token) throw new Error("Token refresh returned no access_token");
  return { accessToken: data.access_token, rotated: data.refresh_token || null };
}

async function refreshAccessToken(env, ctx) {
  let lastErr = null;

  // 1. 依序嘗試 token 來源:KV → env refresh token(不想要 KV 就只設 env)
  const sources = [];
  if (env.FLOWMUSIC_KV) sources.push("kv");
  sources.push("env");

  for (const src of sources) {
    let refreshToken = null;
    if (src === "kv") refreshToken = (await env.FLOWMUSIC_KV.get(KV_REFRESH_KEY)) || null;
    else refreshToken = env.FLOWMUSIC_REFRESH_TOKEN || null;
    if (!refreshToken) continue;
    try {
      const { accessToken, rotated } = await doRefresh(refreshToken);
      cachedAccess = {
        token: accessToken,
        expiresAt: Date.now() + 3600 * 1000 - 60_000, // access token 約 1 小時,提前 1 分鐘刷新
      };
      // 輪替後的 refresh token 存 KV(僅當 KV 存在;沒有 KV 就持續重用 env token,不推進鏈)
      // 直接 await:CF 與 Vercel edge 都相容(不依賴 waitUntil)
      if (rotated && env.FLOWMUSIC_KV) {
        await env.FLOWMUSIC_KV.put(KV_REFRESH_KEY, rotated);
      }
      return accessToken;
    } catch (e) {
      lastErr = e;
    }
  }

  // 2. 沒有 refresh token 時,退回靜態 access token(短效,約 1 小時)
  if (env.FLOWMUSIC_ACCESS_TOKEN) {
    cachedAccess = { token: env.FLOWMUSIC_ACCESS_TOKEN, expiresAt: 0 };
    return env.FLOWMUSIC_ACCESS_TOKEN;
  }

  // 3. 全部失敗 → 明確的診斷訊息
  if (lastErr) {
    const text = lastErr.body || "";
    if (/refresh_token_already_used|invalid.*refresh|token.*expired/i.test(text)) {
      throw new Error(
        "FLOWMUSIC_REFRESH_TOKEN invalid/expired (Supabase rotates tokens on use). " +
          "Re-login to flowmusic.app, copy the fresh sb-sb-auth-token.0 cookie, run " +
          "'python scripts/extract_cookie.py cookie.txt' to get the refresh_token, then set it " +
          "in the Cloudflare Dashboard (Worker → Settings → Variables and Secrets)."
      );
    }
    throw lastErr;
  }
  const kvOk = !!(env.FLOWMUSIC_KV && (await env.FLOWMUSIC_KV.get(KV_REFRESH_KEY)));
  throw new Error(
    "No FLOWMUSIC_REFRESH_TOKEN / FLOWMUSIC_ACCESS_TOKEN configured" +
      ` (KV binding present: ${!!env.FLOWMUSIC_KV}, KV has refresh token: ${kvOk})`
  );
}

/** 取得目前有效的 flowmusic access token(記憶體快取 + 到期自動續期)。 */
export async function getAccessToken(env, ctx) {
  if (cachedAccess && cachedAccess.expiresAt > Date.now()) return cachedAccess.token;
  const token = await refreshAccessToken(env, ctx);
  return token;
}

/** 產生帶 Authorization 的上游請求 headers */
export async function upstreamHeaders(env, ctx, extra = {}) {
  const token = await getAccessToken(env, ctx);
  return {
    Authorization: "Bearer " + token,
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "flowmusic-studio/0.1",
    ...extra,
  };
}
