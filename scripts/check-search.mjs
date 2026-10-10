import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const messages = {
 configuration: "搜索地址配置无效。",
 network: "搜索网络或 DNS 不可用，请检查搜索 DNS 和出站代理。",
 timeout: "搜索请求超时，请检查出站网络。",
 http: "搜索接口或上游引擎拒绝请求。",
 captcha: "上游引擎要求验证，请检查出站网络或更换可用引擎。",
 "invalid-response": "搜索接口返回格式无效。",
 "no-match": "公开测试查询未取得可用来源，请检查引擎配置和出站网络。",
};

export class SearchCheckFailure extends Error {
 constructor(category, retryable = true) {
  super(messages[category]);
  this.category = category;
  this.retryable = retryable;
 }
}

async function boundedJson(response) {
 const reader = response.body?.getReader();
 if (!reader) throw new SearchCheckFailure("invalid-response", false);
 const chunks = [];
 let size = 0;
 try {
  for (;;) {
   const { done, value } = await reader.read();
   if (done) break;
   size += value.byteLength;
   if (size > 1_000_000) throw new SearchCheckFailure("invalid-response", false);
   chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new SearchCheckFailure("invalid-response", false); }
 } finally {
  await reader.cancel().catch(() => {});
  reader.releaseLock();
 }
}

function acceptedCount(candidates) {
 const seen = new Set();
 const plain = value => typeof value === "string" ? value.slice(0, 5000).replace(/<[^>]*>/gu, "").replace(/[\u0000-\u001f]/gu, " ").trim() : "";
 for (const candidate of candidates) {
  if (!candidate || typeof candidate !== "object" || typeof candidate.url !== "string") continue;
  let url;
  try { url = new URL(candidate.url); } catch { continue; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
   !plain(candidate.title) || !plain(candidate.content ?? candidate.snippet)) continue;
  seen.add(url.href);
  if (seen.size === 5) break;
 }
 return seen.size;
}

function engineFailure(raw) {
 const reasons = Array.isArray(raw.unresponsive_engines)
  ? raw.unresponsive_engines.slice(0, 32).flatMap(entry => Array.isArray(entry) && typeof entry[1] === "string" ? [entry[1].toLowerCase()] : []) : [];
 if (reasons.some(reason => /network|connection|connect|dns/u.test(reason))) return new SearchCheckFailure("network");
 if (reasons.some(reason => /timeout/u.test(reason))) return new SearchCheckFailure("timeout");
 if (reasons.some(reason => /captcha|验证/u.test(reason))) return new SearchCheckFailure("captcha", false);
 if (reasons.some(reason => /http|403|429|500|502|503/u.test(reason))) return new SearchCheckFailure("http");
 return new SearchCheckFailure("no-match");
}

/** Read-only public probes, independent of application credentials, caches and quotas. */
export async function checkSearch(endpoint, { request = fetch, timeoutMs = 60000, attempts = 6, retryDelayMs = 2000 } = {}) {
 let base;
 try { base = new URL(`${endpoint?.replace(/\/$/u, "")}/`); } catch { throw new SearchCheckFailure("configuration", false); }
 if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash)
  throw new SearchCheckFailure("configuration", false);
 const deadline = AbortSignal.timeout(timeoutMs);
 let failure = new SearchCheckFailure("network");
 for (let attempt = 0; attempt < attempts && !deadline.aborted; attempt++) {
  const report = [];
  try {
   for (const [language, query] of [["zh-CN", "Python 官方文档"], ["en", "Python official documentation"]]) {
    const url = new URL("search", base);
    for (const [key, value] of Object.entries({ q: query, format: "json", categories: "general", language })) url.searchParams.set(key, value);
    const signal = AbortSignal.any([deadline, AbortSignal.timeout(12000)]);
    let response;
    try {
     response = await request(url, { redirect: "error", signal, headers: {
      accept: "application/json", "cache-control": "no-cache, no-store",
      "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1",
     } });
    } catch { throw new SearchCheckFailure(signal.aborted ? "timeout" : "network"); }
    if (!response.ok) {
     await response.body?.cancel().catch(() => {});
     throw new SearchCheckFailure("http", response.status >= 500);
    }
    const raw = await boundedJson(response);
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.results)) throw new SearchCheckFailure("invalid-response", false);
    const accepted = acceptedCount(raw.results);
    if (!accepted) throw engineFailure(raw);
    report.push({ language, candidateCount: raw.results.length, acceptedCount: accepted });
   }
   return report;
  } catch (error) {
   failure = error instanceof SearchCheckFailure ? error : new SearchCheckFailure(deadline.aborted ? "timeout" : "network");
   if (!failure.retryable || attempt + 1 === attempts) break;
   try { await setTimeout(Math.min(retryDelayMs * 2 ** attempt, 10000), undefined, { signal: deadline }); }
   catch { break; }
  }
 }
 throw failure;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 try {
  const report = await checkSearch(process.env.SETDRAFT_SEARCH_URL);
  console.log(`搜索预检通过：${report.map(item => `${item.language} ${item.candidateCount}/${item.acceptedCount}`).join("，")}（候选/接受）。`);
 } catch (error) {
  console.error(`搜索预检失败：${error instanceof SearchCheckFailure ? error.message : messages.network}`);
  process.exitCode = 1;
 }
}
