/**
 * 共享 API 客户端
 * 合并 business.js / quotes-api.js / account-profit.js 中重复的 HTTP 请求逻辑
 */

import {
  API_BASE, API_PATH, HTTP_HEADERS, API_DEFAULTS, FETCH_TIMEOUT_MS,
} from "./constants.js";
import { getCookie, getUserId, checkCookieValid, retry, AppError } from "./utils.js";

// ============================ API 请求 ============================

/**
 * 通用 POST 请求（带重试、超时、Cookie 校验、error_code 检查）
 * @param {string} path - API 路径（相对路径，如 "/caishen_fund/..."）
 * @param {object} params - 请求参数（与 API_DEFAULTS 合并）
 * @param {number} [maxRetries=2] - 最大重试次数
 * @returns {Promise<object>} ex_data 响应数据
 * @throws {AppError} 请求失败时抛出
 */
export async function apiPost(path, params, maxRetries = 2) {
  return retry(
    async () => {
      checkCookieValid();
      const cookie = getCookie();
      const userId = getUserId();
      const body = new URLSearchParams({
        userid: userId,
        ...API_DEFAULTS,
        ...params,
      });

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
    },
    maxRetries,
    1000,
  );
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