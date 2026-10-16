/**
 * 共享 API 客户端
 * 合并 business.js / quotes-api.js / account-profit.js 中重复的 HTTP 请求逻辑
 *
 * 反爬要点（tzzb.10jqka.com.cn 前置 Nginx）：
 * 1) 全局串行 + 请求最小间隔，避免并发突发被风控直接 403；
 * 2) 403 = Nginx 风控（非业务错误），必须长退避重试，不能按普通错误快速重试。
 */

import {
  API_BASE, API_PATH, HTTP_HEADERS, API_DEFAULTS, FETCH_TIMEOUT_MS,
  REQUEST_MIN_INTERVAL_MS, THROTTLE_BACKOFF_MS, THROTTLE_MAX_RETRIES,
} from "./constants.js";
import { getCookie, getUserId, checkCookieValid, AppError } from "./utils.js";

// ============================ 限流调度 ============================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms + Math.floor(Math.random() * 500);

let lastRequestAt = 0;
let queue = Promise.resolve();

/** 把任务排进全局串行队列，并保证相邻请求间隔 >= REQUEST_MIN_INTERVAL_MS */
function schedule(task) {
  const run = queue.then(async () => {
    const wait = lastRequestAt + REQUEST_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await task();
    } finally {
      lastRequestAt = Date.now();
    }
  });
  // 队列不因单个任务失败而中断
  queue = run.then(() => undefined, () => undefined);
  return run;
}

// ============================ API 请求 ============================

/**
 * 通用 POST 请求（全局串行 + 限速 + 403 长退避重试 + 超时 + Cookie 校验 + error_code 检查）
 * @param {string} path - API 路径（相对路径，如 "/caishen_fund/..."）
 * @param {object} params - 请求参数（与 API_DEFAULTS 合并）
 * @returns {Promise<object>} ex_data 响应数据
 * @throws {AppError} 请求失败时抛出
 */
export async function apiPost(path, params) {
  return schedule(async () => {
    checkCookieValid();
    const cookie = getCookie();
    const userId = getUserId();
    const body = new URLSearchParams({
      userid: userId,
      ...API_DEFAULTS,
      ...params,
    });

    let throttleAttempt = 0;
    for (;;) {
      let res;
      try {
        res = await fetch(`${API_BASE}${path}`, {
          method: "POST",
          headers: {
            "User-Agent": HTTP_HEADERS.USER_AGENT,
            "Content-Type": HTTP_HEADERS.CONTENT_TYPE,
            "Origin": HTTP_HEADERS.ORIGIN,
            "Referer": HTTP_HEADERS.REFERER,
            cookie,
          },
          body: body.toString(),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch (error) {
        throw new AppError(`网络请求失败: ${error.message}`, "NETWORK_ERROR");
      }

      // 403 = Nginx 风控拦截（非业务错误），长退避后再试
      if (res.status === 403) {
        if (throttleAttempt >= THROTTLE_MAX_RETRIES) {
          throw new AppError(
            "HTTP 403: 触发服务端风控限流，已重试 "
              + `${THROTTLE_MAX_RETRIES} 次。请降低请求频率，稍后再试`,
            "THROTTLED",
            403,
          );
        }
        const delay = jitter(
          THROTTLE_BACKOFF_MS[
            Math.min(throttleAttempt, THROTTLE_BACKOFF_MS.length - 1)
          ],
        );
        throttleAttempt += 1;
        console.error(
          `  [风控] HTTP 403，${Math.round(delay / 1000)}s 后第 ${throttleAttempt} 次重试`,
        );
        await sleep(delay);
        continue;
      }

      if (!res.ok) {
        throw new AppError(
          `HTTP ${res.status}: ${res.statusText}`,
          "HTTP_ERROR",
          res.status,
        );
      }

      let json;
      try {
        json = await res.json();
      } catch (error) {
        throw new AppError(`JSON 解析失败: ${error.message}`, "PARSE_ERROR");
      }

      if (json.error_code !== "0") {
        throw new AppError(json.error_msg || "请求失败", "API_ERROR");
      }

      return json.ex_data;
    }
  });
}

// ============================ 账户查询 ============================

/**
 * 获取账户列表
 * @returns {Promise<Array<{fund_key: string, manualname: string}>>} 账户列表
 */
export async function getAccounts() {
  const data = await apiPost(API_PATH.ACCOUNT_LIST, {
    user_id: getUserId(),
  });
  return (data.common || []).map((item) => ({
    fund_key: item.fund_key,
    manualname: item.manualname,
  }));
}

/**
 * 按名称过滤账户
 * @param {Array<{fund_key: string, manualname: string}>} accounts - 账户列表
 * @param {string} filterStr - 过滤关键词
 * @returns {Array} 过滤后的账户列表
 */
export function filterAccounts(accounts, filterStr) {
  const lower = filterStr.toLowerCase();
  return accounts.filter((a) => a.manualname?.toLowerCase().includes(lower));
}