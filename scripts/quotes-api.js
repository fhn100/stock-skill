/**
 * 行情查询 API 模块
 * 依赖 api-client.js 共享的 HTTP 客户端
 */

import { apiPost, getAccounts, filterAccounts } from "./api-client.js";
import { getUserId, getTodayDate, maskAccountName } from "./utils.js";
import { API_PATH } from "./constants.js";

// ============================ 账户与行情 ============================

/**
 * 获取股票行情
 * @param {string} code - 股票代码，格式 "市场:代码"
 * @returns {Promise<Map<string, {profit: number, profit_rate: string}>>} 行情数据
 */
async function passQuotes(code) {
  const userId = getUserId();
  const date = getTodayDate();
  const data = await apiPost(API_PATH.PASS_QUOTES, {
    userid: userId,
    user_id: userId,
    code: code,
    date: date,
  });
  return new Map(
    (data || []).map((item) => [
      item.zqdm,
      {
        profit: item.xianjia - item.zuoshou,
        profit_rate: item.zuoshou > 0
        ? (((item.xianjia - item.zuoshou) * 100) / item.zuoshou).toFixed(2) + "%"
        : "0.00%",
      },
    ]),
  );
}

// ============================ 持仓行情 ============================

/**
 * 获取单个账户的持仓数据
 * @param {string} userId - 用户 ID
 * @param {string} fundKey - 基金 KEY
 * @returns {Promise<Array>} 持仓列表
 */
async function fetchPosition(userId, fundKey) {
  const data = await apiPost(API_PATH.STOCK_POSITION, {
    fund_key: fundKey,
    userid: userId,
    user_id: userId,
  });
  return data.position || [];
}

/**
 * 构建单条股票持仓记录
 * @param {string} accountName - 脱敏后的账户名
 * @param {object} pos - 持仓项
 * @param {object} quote - 行情数据 { profit, profit_rate }
 * @returns {object} 格式化后的持仓记录
 */
function buildStockItem(accountName, pos, quote) {
  const profitValue = quote.profit || 0;
  const holdingValue = (pos.entry_cost || 0) * (pos.count || 0);
  return {
    账户名称: accountName,
    代码: pos.code || "-",
    名称: pos.name || "未知股票",
    持有金额: holdingValue.toFixed(2),
    当日盈亏: (profitValue * (pos.count || 0)).toFixed(2),
    当日盈亏率: quote.profit_rate || "0.00%",
  };
}

/**
 * 构建账户汇总行
 * @param {Array} stocks - 该账户所有股票记录
 * @returns {object} 汇总记录
 */
function buildAccountSummary(stocks) {
  const num = (key) =>
    stocks.reduce((sum, s) => sum + (parseFloat(s[key]) || 0), 0);
  const totalDailyProfit = num("当日盈亏");
  const totalHoldingValue = num("持有金额");

  return {
    账户名称: "汇总",
    代码: "",
    名称: "",
    当日盈亏: totalDailyProfit.toFixed(2),
    当日盈亏率: formatRate(totalDailyProfit, totalHoldingValue),
  };
}

/** 格式化百分比 */
function formatRate(numerator, denominator) {
  if (denominator === 0) return "0.00%";
  return ((numerator / denominator) * 100).toFixed(2) + "%";
}

/**
 * 处理单个账户的持仓 + 行情 + 汇总
 * @param {string} userId - 用户 ID
 * @param {object} account - { fund_key, manualname }
 * @returns {Promise<Array>} 该账户的全部记录（含汇总行）
 */
async function processAccount(userId, account) {
  const accountName = maskAccountName(account.manualname);
  const positions = await fetchPosition(userId, account.fund_key);

  if (positions.length === 0) return [];

  const code = positions.map((p) => `${p.market}:${p.code}`).join(",");
  const quotes = code ? await passQuotes(code) : new Map();

  const stocks = positions.map((pos) =>
    buildStockItem(
      accountName,
      pos,
      quotes.get(pos.code) || { profit: 0, profit_rate: "0.00%" },
    ),
  );

  stocks.sort(
    (a, b) =>
      (parseFloat(b["当日盈亏率"]) || 0) - (parseFloat(a["当日盈亏率"]) || 0),
  );

  stocks.push(buildAccountSummary(stocks));
  return stocks;
}

/**
 * 获取持仓行情数据
 * @param {string} [accountNameFilter] - 账户名称过滤器
 * @returns {Promise<Array>} 行情数据数组
 */
export async function getQuotes(accountNameFilter) {
  let accounts = await getAccounts();

  if (accountNameFilter) {
    accounts = filterAccounts(accounts, accountNameFilter);
    if (accounts.length === 0) {
      console.warn(`⚠️ 未找到包含「${accountNameFilter}」的账户`);
      return [];
    }
  }

  const userId = getUserId();

  // 并行拉取所有账户（纯 API 调用，无 DB 操作，无写锁风险），保持账户顺序
  const accountResults = await Promise.all(
    accounts.map(async (account) => {
      try {
        return { stocks: await processAccount(userId, account), error: null };
      } catch (error) {
        const name = maskAccountName(account.manualname);
        console.error(`获取账户 ${name} 行情失败:`, error.message);
        return { stocks: [], error };
      }
    }),
  );

  return accountResults.flatMap((r) => r.stocks);
}