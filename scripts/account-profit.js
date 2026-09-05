#!/usr/bin/env node

/**
 * 账户收益卡片脚本 - 获取各账户的总资产与盈亏
 * 用法: node account-profit.js [accountName] [--json]
 * accountName: 账户名称关键词（可选）
 * --json: 以 JSON 格式输出（便于程序消费）
 */

import { apiPost, getAccounts, filterAccounts } from "./api-client.js";
import { API_PATH } from "./constants.js";
import { maskAccountName, printApiError } from "./utils.js";

// ============================ 数据获取 ============================

/**
 * 获取单个账户的收益卡片数据
 * @param {string} fundKey - 基金 KEY
 * @returns {Promise<{asset, profit, now_profit, now_rate}>}
 */
async function getStockCard(fundKey) {
  const data = await apiPost(API_PATH.STOCK_CARD, { fund_key: fundKey });
  return {
    asset: parseFloat(data.asset) || 0,
    profit: parseFloat(data.profit) || 0,
    now_profit: parseFloat(data.now_profit) || 0,
    now_rate: parseFloat(data.now_rate) || 0, // 百分比数值，如 0.69 表示 0.69%
  };
}

/**
 * 获取所有账户的收益卡片数据（含汇总行）
 * 并行拉取所有账户，汇总后统一计算合计行
 * @param {string} [accountNameFilter] - 账户名称过滤器
 * @returns {Promise<Array>} 收益数据数组
 */
export async function getAccountProfits(accountNameFilter) {
  let accounts = await getAccounts();

  if (accountNameFilter) {
    accounts = filterAccounts(accounts, accountNameFilter);
    if (accounts.length === 0) {
      console.warn(`⚠️ 未找到包含「${accountNameFilter}」的账户`);
      return [];
    }
  }

  // 并行拉取所有账户的收益数据
  const cardResults = await Promise.all(
    accounts.map(async (account) => {
      try {
        const card = await getStockCard(account.fund_key);
        return { account, card, error: null };
      } catch (error) {
        const name = maskAccountName(account.manualname);
        console.error(`获取账户 ${name} 收益失败:`, error.message);
        return { account, card: null, error };
      }
    })
  );

  // 汇总
  let sumAsset = 0;
  let sumProfit = 0;
  let sumNowProfit = 0;
  const results = [];

  for (const { account, card, error } of cardResults) {
    if (error || !card) continue;
    const accountName = maskAccountName(account.manualname);
    results.push({
      账户名称: accountName,
      总资产: card.asset.toFixed(2),
      持有盈亏: card.profit.toFixed(2),
      当日盈亏: card.now_profit.toFixed(2),
      当日收益率: card.now_rate.toFixed(2) + "%",
    });
    sumAsset += card.asset;
    sumProfit += card.profit;
    sumNowProfit += card.now_profit;
  }

  // 汇总行：当日收益率 = 当日盈亏 / (总资产 - 当日盈亏) * 100
  const totalNowRate =
    sumAsset - sumNowProfit > 0 ? (sumNowProfit / (sumAsset - sumNowProfit)) * 100 : 0;

  results.push({
    账户名称: "汇总",
    总资产: sumAsset.toFixed(2),
    持有盈亏: sumProfit.toFixed(2),
    当日盈亏: sumNowProfit.toFixed(2),
    当日收益率: totalNowRate.toFixed(2) + "%",
  });

  return results;
}

// ============================ 主流程 ============================

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const accountFilter = args.find((a) => a !== "--json") || undefined;

try {
  console.log("正在获取账户收益...");
  const results = await getAccountProfits(accountFilter);

  if (jsonMode) {
    console.log(JSON.stringify(results, null, 2));
    process.exit(0);
  }

  if (results.length === 0) {
    console.log("暂无账户数据");
  } else {
    console.log("\n| 账户名称 | 总资产 | 持有盈亏 | 当日盈亏 | 当日收益率 |\n|---|---|---|---|---|");
    for (const row of results) {
      console.log(
        `| ${row["账户名称"]} | ${row["总资产"]} | ${row["持有盈亏"]} | ${row["当日盈亏"]} | ${row["当日收益率"]} |`
      );
    }
    console.log("");
  }
} catch (e) {
  console.error("获取账户收益失败:");
  printApiError(e);
  process.exit(1);
}