#!/usr/bin/env node

/**
 * 独立收益查询脚本 - 不依赖 opencli
 * 用法: node profit.js [startMonth] [endMonth]
 * 月份格式: YYYY-MM，默认当月
 */

import { tradeMatch, gridProfit } from "./business.js";
import { getCurrentMonth, monthRange, lastDayOfMonth, renderTable } from "./utils.js";
import { withDb } from "./db.js";
import { TABLE } from "./constants.js";

// 解析命令行参数
const args = process.argv.slice(2);
const start = args[0] || getCurrentMonth();
const end = args[1] || start;

/**
 * 清理脏数据（过户费=0 的旧快照）：
 * - 匹配记录：清理【查询月份范围】内的记录 → tradeMatch 会用交易表的最新费用重新配对（安全）
 * - 交易记录：本脚本不再同步数据，删除后无法重拉，只统计并提示用 `opencli stock sync` 修复
 * @param {string} start - 查询起始月 YYYY-MM
 * @param {string} end - 查询结束月 YYYY-MM
 */
async function cleanDirtyFees(start, end) {
  const months = monthRange(start, end);
  if (months.length === 0) return;
  const placeholders = months.map(() => "?").join(",");
  const range = `${months[0]}~${months[months.length - 1]}`;

  await withDb(async (db) => {
    // 1) 匹配记录：清理后由 tradeMatch 用交易表最新费用重新配对
    const matchedWhere = `(sell_transfer_fee = 0 OR buy_transfer_fee = 0)
       AND strftime(sell_time, '%Y-%m') IN (${placeholders})`;
    const matchedCount = Number((await db.all(
      `SELECT count(*) AS n FROM ${TABLE.TRADE_MATCHED} WHERE ${matchedWhere}`, months,
    ))[0]?.n ?? 0);
    if (matchedCount > 0) {
      await db.run(`DELETE FROM ${TABLE.TRADE_MATCHED} WHERE ${matchedWhere}`, months);
      console.log(`已清理查询范围匹配记录（过户费=0）[${range}]: ${matchedCount} 条`);
    }

    // 2) 交易记录：只提示不删（需 opencli stock sync 重拉才能修复费用）
    const tradeCount = Number((await db.all(
      `SELECT count(*) AS n FROM ${TABLE.TRADE_RECORD}
        WHERE transfer_fee = 0 AND substr(entry_date, 1, 7) IN (${placeholders})`, months,
    ))[0]?.n ?? 0);
    if (tradeCount > 0) {
      const lastMonth = months[months.length - 1];
      console.log(`⚠️  查询范围内 ${tradeCount} 条交易记录过户费=0（未自动清理）；如需修复费用，执行: `
        + `opencli stock sync ${months[0].replace("-", "")}01 `
        + `${lastMonth.replace("-", "")}${lastDayOfMonth(lastMonth)} 后重跑本脚本`);
    }
  });
}

function printProfit(results) {
  if (!results || results.length === 0) {
    console.log("暂无收益数据");
    return;
  }
  const rows = results.map((row) => [
    row["账户"] || "",
    row["股票代码"] || "",
    row["股票名称"] || "",
    row["时间"] || "",
    row["交易次数"] ?? "",
    Number(row["总收益"] || 0).toFixed(2),
  ]);
  console.log("\n📊 收益统计结果：");
  console.log(renderTable(
    ["账户", "股票代码", "股票名称", "时间", "交易次数", "总收益"],
    rows,
  ));
}

try {
  await cleanDirtyFees(start, end);

  // 匹配交易记录（先买后卖，仅盈利；对全库未匹配记录重算）
  await tradeMatch();

  console.log(`查询范围：${start} ~ ${end}`);
  printProfit(await gridProfit(start, end));
} catch (e) {
  console.error("查询网格收益失败:", e.message);
  process.exit(1);
}
