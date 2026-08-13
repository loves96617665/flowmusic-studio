# 🎵 Flow Music Studio

> **OpenAI-compatible gateway for Google Flow Music (Lyria 3.5 / Lyria 3 Pro) · Deployed on Vercel (free tier) / 部署在 Vercel(免費版)**
> **Google Flow Music(Lyria)音樂生成閘道 — OpenAI 相容 API + API Key 驗證**

A serverless gateway that wraps the private web API of [Google Flow Music](https://www.flowmusic.app/) — Google DeepMind's music generation platform powered by **Lyria 3.5** — behind a clean, OpenAI-compatible interface. Built from a full reverse-engineering of the official frontend (`_app.js`), verified end-to-end against the live API.

把 Google Flow Music(DeepMind Lyria 3.5 音樂模型)的私有不公開網頁 API 包裝成 OpenAI 相容介面的無伺服器閘道。基於官方前端(`_app.js`)的完整逆向分析,並已對線上 API 做過端到端實測驗證。

---

## ✨ Features / 功能

| English | 中文 |
|---|---|
| 🧠 **Producer chat agent** — talk to the same AI agent as the official app; it decides tools and generates 2 variants per run | 聊天代理 — 與官方 /session 相同的 agent 流程,自動決定工具並生成 2 個變體 |
| 🎛 **Deterministic generation** — `audio__create_song` with explicit `lyrics` / `title` / `seed` / `n` / `bpm` / `duration` | 直接生成 — 確定性呼叫 `audio__create_song`,可控歌詞/標題/種子/數量/BPM/長度 |
| 🎚 **Remix & editing** — `extend` / `replace` / `cover` via `audio__render_edit` (recipe graph) | 編輯重混 — extend(延伸)/ replace(區段替換)/ cover(翻唱),走官方 recipe 節點圖 |
| ✂️ **Stem split** — separate vocals / drums / bass / other tracks | 分軌 — 分離人聲/鼓/貝斯/其他四軌 |
| 🔑 **API Key auth** — your clients use disposable keys; your upstream session stays secret | API Key 驗證 — 用戶用可拋棄的 key,你的上游登入態不外流 |
| ♻️ **Auto token refresh** — Supabase refresh token renews the access token (no KV needed) | 自動續期 — 用 Supabase refresh token 換 access token(不需任何 KV) |
| 🎼 **Lyrics hashing** — byte-for-byte identical UUID v5 (`uuid5(lyrics, b8f9e3a1-...)`) as the official app, verified against real server output | 歌詞哈希 — 與官方完全一致的 UUID v5,已與伺服器實際回傳逐位元組驗證 |
| 📡 **Native SSE handling** — parses both chat (`part`/`delta`) and tool-call (`message`) stream formats | SSE 解析 — 同時支援聊天與工具調用兩種串流格式 |
| 🌐 **Web UI** — minimal single-page UI included (audio playback included) | 簡易網頁 UI — 附帶單頁介面(含音訊播放) |
| 🆓 **Vercel free tier** — zero external dependencies, tiny bundle | Vercel 免費版 — 零外部依賴,bundle 極小 |

## 🏗 Architecture / 架構

```text
OpenAI SDK / curl / Browser UI
        │  Authorization: Bearer <API Key>
        ▼
Vercel Edge Function — api/index.js (this project)
        │  1. validate API key (env API_KEYS)
        │  2. call upstream with auto-refreshed Supabase access token
        ▼
www.flowmusic.app/__api/*   ← official backend (Next.js rewrite proxy)
```

**Why `/__api`?** The browser never talks to `wb.flowmusic.app` directly (it returns 403); the official frontend calls same-origin `/__api/*`, which Next.js unconditionally rewrites to the backend at `/api/backend/*`. We reuse that exact path.

為什麼是 `/__api`?瀏覽器不會直接打 `wb.flowmusic.app`(會被 403);官方前端呼叫同源 `/__api/*`,Next.js 無條件 rewrite 到後端 `/api/backend/*`。我們複用同一路徑。

## 🚀 Deploy (Vercel, Free Tier) / 部署

架構:單一 Vercel Edge Function(`api/index.js`)+ `vercel.json` rewrites,靜態 UI 由 Vercel 直接服務。Edge runtime 用 Web Request/Response API,與 CF Worker 共用同一份 `route()` 邏輯。

```bash
cd flowmusic-studio
npm install

# 1) 本地開發(可選)
npm run dev          # vercel dev → http://localhost:3000

# 2) 部署到 Vercel(會跳出瀏覽器授權一次)
npm run deploy       # vercel deploy --prod

# 3) 設定環境變數 — 用 Vercel Dashboard 圖形介面(免 CLI):
#    https://vercel.com → 你的專案 → Settings → Environment Variables → Add
#    新增兩個(Production 也要勾選):
#      FLOWMUSIC_REFRESH_TOKEN = <refresh token>
#      API_KEYS                  = sk-flow-aaa,sk-flow-bbb
#    拿到 refresh token:
#      登入 www.flowmusic.app → F12 → Application → Cookies → 複製整段
#      sb-sb-auth-token.0(以 base64- 開頭)存成 cookie.txt,然後:
#      python scripts/extract_cookie.py cookie.txt   # 會印出完整的 refresh_token
#    改完後 Redeploy(或直接改 "Development" 之後 deploy 一次)

# 4) Done 🎉 測試:
curl https://<你的專案>.vercel.app/v1/models -H "Authorization: Bearer sk-flow-aaa"
```

> **Token 策略(無 KV)**:auth.js 每小時重用同一個 `FLOWMUSIC_REFRESH_TOKEN`,**不消耗**輪替後的繼任者,token 在「沒有其他東西推進鏈」的前提下長期有效(例外:同時在瀏覽器登入 flowmusic.app 並讓 session 刷新會推進鏈)。失效時錯誤訊息會明說,回 Dashboard 貼一次新的即可。

> **Windows note / Windows 注意**:`extract_cookie.py` 以 `newline=""` 寫檔,避免 token 尾端混入 `\r` 隱藏字元。

## 📡 API

All endpoints require `Authorization: Bearer <API_KEY>`. / 所有端點需帶 `Authorization: Bearer <你的 API Key>`。

```bash
KEY=sk-flow-xxx
BASE=https://<your-project>.vercel.app

# List models / 列模型
curl $BASE/v1/models -H "Authorization: Bearer $KEY"

# Direct generation / 直接生成(OpenAI images/generations style;n=2 → 2 songs)
curl $BASE/v1/music/generations \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "model": "lyria-3.5",
    "prompt": "deep sea techno, bioluminescent textures, hypnotic minimal groove, 124 bpm",
    "title": "Bioluminescence",
    "instrumental": true,
    "n": 2
  }'

# With lyrics, BPM & duration (auto uuid5 hashing + official bpm/[End - mm:ss] injection) / 帶歌詞+BPM+長度
curl $BASE/v1/music/generations \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "prompt": "dreamy synthpop",
    "title": "Neon Tide",
    "lyrics": "Under neon skies we drift\nsilent waves, electric tide",
    "bpm": 100,
    "duration": 180,
    "seed": 42
  }'

# Remix / edit: extend a song by 30s / 編輯:延伸 30 秒
curl $BASE/v1/music/edits \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "mode": "extend",
    "clip_id": "<song-id>",
    "instruction": "add a dreamy synth outro, fade out slowly",
    "extend_s": 30,
    "extend_from_s": 140,
    "title": "Neon Tide (Extended)"
  }'

# Cover a song / 翻唱
curl $BASE/v1/music/edits \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"mode": "cover", "clip_id": "<song-id>", "instruction": "jazz version with female vocals", "strength": 0.5}'

# Replace a section / 替換區段
curl $BASE/v1/music/edits \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"mode": "replace", "clip_id": "<song-id>", "instruction": "more energetic drums", "masks": [{"start_s": 30, "end_s": 60}]}'

# Split stems / 分軌(vocals · drums · bass · other)
curl $BASE/v1/music/stems \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"clip_id": "<song-id>"}'

# Producer chat agent / 聊天代理(agent decides tools, generates 2 variants)
curl $BASE/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "model": "lyria-3.5",
    "messages": [{"role": "user", "content": "做一首日系史詩搖滾,女聲"}]
  }'
```

### Responses / 回應格式

- `POST /v1/music/generations` → `{ created, model, data: [{ id, title, url (audio), wav_url, image_url, duration, lyrics, created_at }] }`;extra params `bpm`(尾綴 `, {bpm} bpm`)、`duration` 秒(歌詞尾綴 `[End - mm:ss]`,與官方一致)、`seed`、`n`
- `POST /v1/music/edits` → `{ created, model, mode, data: [...] }`;`extend`(`extend_s` / `extend_from_s`)、`replace`(`masks:[{start_s,end_s}]` 或 `start_s`/`end_s`)、`cover`(`strength` 0–1,預設 0.5)
- `POST /v1/music/stems` → `{ created, model, data: [{ stem_type: "vocals"|"drums"|"bass"|"other", id, url, wav_url }] }`
- `POST /v1/chat/completions` → standard OpenAI `chat.completion` (`choices[0].message.content` + `tool_calls`), plus a `songs` extension field
- `GET /v1/models` → OpenAI model list (`Lyria 3.5` default, `Lyria 3 Pro` legacy)
- `GET /v1/songs` / `GET /v1/songs/:id` → your songs

**Model aliases / 模型別名:** `lyria-3.5` · `lyria_3_5` · `g1` · `Lyria 3.5` → **Lyria 3.5**;`lyria-3-pro` → **Lyria 3 Pro**. Default `Lyria 3.5`.

## 🔬 Reverse-Engineering Notes / 逆向重點

All protocol details below were extracted from the official bundle and **verified against the live API** (real generations, real SSE streams).

以下協定細節皆出自官方 bundle 並已**對線上 API 實測驗證**(真實生成、真實 SSE 串流)。

- **Auth / 認證**: `Authorization: Bearer <Supabase access_token>` (Google OAuth). Refresh: `POST https://sb.flowmusic.app/auth/v1/token?grant_type=refresh_token`
- **Chat / 聊天**: `POST /conversation` with `model_name: "producer:standard"` (the *agent* name — the model lives in `client_context.selected_model`) → `{job_id}` → SSE `GET /messages/{job}/stream?last_id=0`
- **SSE events**: `begin` · `conversation_id` · `part` (`status: start|delta|final`, `delta` = incremental text) · `complete` · `generated-title` · `suggestion` · `final`. The tool-call stream instead uses `message` events with a `parts` array. CRLF line endings.
- **Tool call / 工具調用**: `POST /producer/tool-call` `{conversation_id, part:{tool_name,args,tool_call_id,part_kind:"tool-call"}, client_context}`; tool-return carries `{status, operation_id, clip_id, clip_id_b?, a_b_test_id?, estimated_time}`
- **`audio__create_song` args**: `{sound_prompt, lyrics_id, title, seed, image_id}`;`bpm` → `sound_prompt` 尾綴、`duration` → 歌詞尾綴 `[End - mm:ss]`(官方 `_constructCreateArgs` 邏輯)
- **`audio__render_edit`**: `POST /recipes/create` body `{recipe:{nodes,instruction}}` → `{recipe_id}`,再 tool-call `{recipe_id, title}`;tool-return 用 `clip_outputs:[{node_id, clip_id, title}]`(不是 `clip_id`)
- **`audio__split_stems`**: args `{clip_id}`;tool-return `{stems:[{stem_type:"vocals"|"drums"|"bass"|"other", clip_id}]}`
- **Lyrics hashing / 歌詞哈希**: UUID v5 (SHA-1), namespace `b8f9e3a1-7c2d-4f5e-9a8b-1c3d5e7f9a2b`; empty / whitespace / `"[Instrumental]"` → no `lyrics_id` (pure instrumental). Server-side value verified: `uuid5("[Instrumental]") == 55161754-f78d-5b7f-9fa2-6a3cc8d6ba93`
- **Cost / 成本 (2026-08)**: direct generation ≈ **60 tokens/song**; chat agent flow ≈ 120–240 tokens (incl. agent processing); free tier grants 360 tokens/day
- **Backend stack / 後端**: Python FastAPI (project codename `corpusant`, `routers/producer.py`)

## 🔧 Environment Variables / 環境變數

| Var | Required | Description / 說明 |
|---|---|---|
| `API_KEYS` (secret) | ✅ | Comma-separated gateway API keys / 逗號分隔的閘道 API Key |
| `FLOWMUSIC_REFRESH_TOKEN` (secret) | ✅ | Supabase refresh token (long-lived / 長效) |
| `FLOWMUSIC_ACCESS_TOKEN` (secret) | optional | Short-lived access token fallback (~1h) |
| `FLOWMUSIC_BASE_URL` | optional | Upstream base, default `https://www.flowmusic.app/__api` |


## 💻 Local dev / 本地開發

```bash
npm run check     # syntax check / 語法檢查
npm test          # unit tests: uuid5 vs known server values, model mapping / 單元測試
npm run test:vercel # Vercel edge handler harness(路徑還原/認證/路由)/ 本地 harness
npm run dev       # vercel dev → http://localhost:3000
npm run test:vercel  # Vercel edge handler harness(路徑還原/認證/路由)
```

## ⚠️ Security / 安全提醒

- `API_KEYS` gate **your gateway**; `FLOWMUSIC_REFRESH_TOKEN` is effectively **your flowmusic account login** — never commit it, never share it.
- Song generation spends the upstream account's credits. / 歌曲生成消耗該 flowmusic 帳號的額度。
- Free tier: 100k requests/day. This project has zero runtime dependencies. / 免費版 100k 請求/日,零執行期依賴。

## 🗺 Roadmap / 規劃

- [ ] `stream: true` support for `/v1/chat/completions` (SSE → OpenAI chunks) / 串流支援
- [x] `/v1/music/edits` — extend / replace / cover(2026-08 已實測) / 音樂編輯 API
- [x] `/v1/music/stems` — stem split(2026-08 已實測) / 分軌
- [ ] Music video generation (`video__create_video_clip`, Veo) / 音樂影片生成
- [ ] Multi-account upstream pool / 多帳號池

## 📄 License / 授權

MIT — for educational purposes. Not affiliated with Google. Use at your own risk.
MIT — 僅供學習研究。非 Google 官方產品,使用風險自負。
