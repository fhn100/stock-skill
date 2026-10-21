#!/usr/bin/env node

/**
 * 独立收益查询脚本 - 不依赖 opencli
 * 用法: node profit.js [startMonth] [endMonth]
 * 月份格式: YYYY-MM，默认当月
 */

import { tradeMatch, gridProfit } from "./business.js";
import { getCurrentMonth } from "./utils.js";
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
  const months = [];
  {
    let [y, m] = start.split("-").map(Number);
    const [ey, em] = end.split("-").map(Number);
    for (let i = 0; i < 1200 && (y < ey || (y === ey && m <= em)); i++) {
      months.push(`${y}-${String(m).padStart(2, "0")}`);
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
  }
  if (months.length === 0) return;

  const monthList = months.map((x) => `'${x}'`).join(",");
  await withDb(async (db) => {
    // 1) 匹配记录：清理后由 tradeMatch 用交易表最新费用重新配对
    const matchedWhere =
      `(sell_transfer_fee = 0 OR buy_transfer_fee = 0) AND strftime(sell_time, '%Y-%m') IN (${monthList})`;
    const matchedRows = await db.all(
      `SELECT count(*) AS n FROM ${TABLE.TRADE_MATCHED} WHERE ${matchedWhere}`,
    );
    const matchedCount = Number(matchedRows[0]?.n ?? 0);
    if (matchedCount > 0) {
      await db.run(`DELETE FROM ${TABLE.TRADE_MATCHED} WHERE ${matchedWhere}`);
      console.log(`已清理查询范围匹配记录（过户费=0）[${months[0]}~${months[months.length - 1]}]: ${matchedCount} 条`);
    }

    // 2) 交易记录：只提示不删（需 opencli stock sync 重拉才能修复费用）
    const tradeRows = await db.all(
      `SELECT count(*) AS n FROM ${TABLE.TRADE_RECORD} WHERE transfer_fee = 0 AND substr(entry_date, 1, 7) IN (${monthList})`,
    );
    const tradeCount = Number(tradeRows[0]?.n ?? 0);
    if (tradeCount > 0) {
      const lastMonth = months[months.length - 1];
      const lastDay = new Date(Number(lastMonth.slice(0, 4)), Number(lastMonth.slice(5, 7)), 0).getDate();
      console.log(`⚠️  查询范围内 ${tradeCount} 条交易记录过户费=0（未自动清理）；如需修复费用，执行: opencli stock sync ${months[0].replace("-", "")}01 ${lastMonth.replace("-", "")}${lastDay} 后重跑本脚本`);
    }
  });
}

try {
  await cleanDirtyFees(start, end);

  // 匹配交易记录（先买后卖，仅盈利）
  await tradeMatch();

  // 查询收益
  console.log(`查询范围：${start} ~ ${end}`);
  const results = await gridProfit(start, end);

  // 格式化输出
  if (results && results.length > 0) {
    console.log("\n📊 收益统计结果：");
    console.log("─".repeat(70));
    console.log(
      "账户".padEnd(12) +
      "股票代码".padEnd(10) +
      "股票名称".padEnd(12) +
      "时间".padEnd(10) +
      "交易次数".padEnd(8) +
      "总收益"
    );
    console.log("─".repeat(70));

    let prevAccount = "";

    for (const row of results) {
      const account = row["账户"] || "";
      const time = row["时间"] || "";
      const code = row["股票代码"] || "";
      const name = row["股票名称"] || "";
      const count = row["交易次数"] || "";
      const profit = row["总收益"] || 0;

      console.log(
        account.padEnd(12) +
        code.padEnd(10) +
        name.padEnd(12) +
        time.padEnd(10) +
        String(count).padEnd(8) +
        profit.toFixed(2)
      );
    }
    console.log("─".repeat(70));
  } else {
    console.log("暂无收益数据");
  }
} catch (e) {
  console.error("查询网格收益失败:", e.message);
  process.exit(1);
}