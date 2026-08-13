/**
 * 單元測試:uuid5(與伺服器已知值比對)、lyrics 工具、model 對映。
 * 用法:node test-openai.mjs
 */
import { normalizeModel, applyBpmDuration } from "./src/routes-openai.js";
import {
  buildExtendRecipe,
  buildReplaceRecipe,
  buildCoverRecipe,
} from "./src/flowmusic.js";
import {
  uuid5,
  lyricsIdFromLyricsText,
  buildLyricsPayload,
  parseUuidBytes,
} from "./src/shared.js";

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗ FAIL:", name); }
}

console.log("== uuid5 (對比伺服器實際回傳) ==");
// 伺服器 clip 的 [Instrumental] lyrics_id(實測值)
const instrumental = await uuid5("[Instrumental]");
assert("uuid5('[Instrumental]') == 55161754-f78d-5b7f-9fa2-6a3cc8d6ba93",
  instrumental === "55161754-f78d-5b7f-9fa2-6a3cc8d6ba93");
// 伺服器擴寫歌詞後的 lyrics_id(實測值)
const expanded = await uuid5(`[Verse 1]
Under neon skies we drift,
Silent waves, electric tide.
Under neon skies we drift,
Silent waves, electric tide.`);
// 用上面第一段即可驗證演算法一致性:與 Python uuid.uuid5 已知結果比對
assert("uuid5 演算法與 RFC4122 一致(hello world)", await uuid5("Hello, world!") === "8c82a92a-db20-5629-a86a-b9d9d5c8265e");
assert("uuid5 中文 UTF-8", await uuid5("測試中文歌詞") === "1829eec0-545f-5f1b-8583-cf87298d0ae9");
assert("uuid5 版本 nibble=5", (await uuid5("x")).slice(14, 15) === "5");
assert("uuid5 namespace 解析 16 bytes", parseUuidBytes("b8f9e3a1-7c2d-4f5e-9a8b-1c3d5e7f9a2b").length === 16);

console.log("== lyricsIdFromLyricsText ==");
assert("空字串 → ''", (await lyricsIdFromLyricsText("")) === "");
assert("純空白 → ''", (await lyricsIdFromLyricsText("   ")) === "");
assert("[Instrumental] → ''", (await lyricsIdFromLyricsText("[Instrumental]")) === "");
assert("正常歌詞 → uuid5", (await lyricsIdFromLyricsText("hello")) === (await uuid5("hello")));

console.log("== buildLyricsPayload ==");
let p = await buildLyricsPayload("some lyrics");
assert("有 lyrics → lyrics_id + map", p.lyrics_id === (await uuid5("some lyrics")) && p.lyrics_id_map[p.lyrics_id] === "some lyrics");
p = await buildLyricsPayload("");
assert("空 → 不帶 lyrics_id", p.lyrics_id === "" && Object.keys(p.lyrics_id_map).length === 0);

console.log("== normalizeModel ==");
assert("lyria-3.5 → Lyria 3.5", normalizeModel("lyria-3.5") === "Lyria 3.5");
assert("lyria_3_5 → Lyria 3.5", normalizeModel("lyria_3_5") === "Lyria 3.5");
assert("g1 → Lyria 3.5", normalizeModel("g1") === "Lyria 3.5");
assert("Lyria 3 Pro → Lyria 3 Pro", normalizeModel("Lyria 3 Pro") === "Lyria 3 Pro");
assert("lyria-3-pro → Lyria 3 Pro", normalizeModel("lyria-3-pro") === "Lyria 3 Pro");
assert("預設 → Lyria 3.5", normalizeModel("") === "Lyria 3.5");
assert("未知 → 原樣", normalizeModel("weird-model") === "weird model");

console.log("== applyBpmDuration(官方 _constructCreateArgs 邏輯) ==");
let r = applyBpmDuration({ prompt: "synthwave", lyrics: "hello", instrumental: false, bpm: 100, duration: 150 });
assert("bpm 尾綴", r.sound_prompt === "synthwave, 100 bpm");
assert("duration 尾綴 [End - mm:ss]", r.lyrics === "hello\n[End - 2:30]");
assert("instrumental 從 [Instrumental] 起算", applyBpmDuration({ prompt: "x", lyrics: "", instrumental: true, bpm: null, duration: 120 }).lyrics === "[Instrumental]\n[End - 2:00]");
assert("無 bpm/duration 保持原樣", applyBpmDuration({ prompt: "x", lyrics: "y", instrumental: false }).sound_prompt === "x" && applyBpmDuration({ prompt: "x", lyrics: "y", instrumental: false }).lyrics === "y");

console.log("== recipe builders ==");
const ext = buildExtendRecipe({ clipId: "c1", instruction: "add outro", extend_s: 30, extend_from_s: 140, seed: 7, title: "T" });
assert("extend 3 節點", ext.nodes.length === 3);
assert("extend Input", ext.nodes[0].node_type === "Input" && ext.nodes[0].clip_id === "c1");
assert("extend ExtendSection 參數", ext.nodes[1].node_type === "ExtendSection" && ext.nodes[1].extend_s === 30 && ext.nodes[1].extend_from_s === 140 && ext.nodes[1].seed === 7);
assert("extend Output title", ext.nodes[2].node_type === "Output" && ext.nodes[2].title === "T");
const rep = buildReplaceRecipe({ clipId: "c1", instruction: "fix", masks: [{ start_s: 0, end_s: 10 }], title: "T" });
assert("replace ReplaceSection masks", rep.nodes[1].node_type === "ReplaceSection" && rep.nodes[1].masks[0].start_s === 0);
const cov = buildCoverRecipe({ clipId: "c1", instruction: "jazz version", title: "T" });
assert("cover 預設 strength 0.5", cov.nodes[1].node_type === "CoverSong" && cov.nodes[1].strength === 0.5);
assert("cover 自訂 strength", buildCoverRecipe({ clipId: "c", instruction: "i", strength: 0.8, title: "T" }).nodes[1].strength === 0.8);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
