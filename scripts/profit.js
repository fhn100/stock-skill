#!/usr/bin/env node

/**
 * 独立收益查询脚本 - 不依赖 opencli
 * 用法: node profit.js [startMonth] [endMonth]
 * 月份格式: YYYY-MM，默认当月
 */

import { syncTrade, tradeMatch, gridProfit } from "./business.js";
import { getCurrentMonth, getDefaultDateRange } from "./utils.js";
import { withDb } from "./db.js";
import { TABLE } from "./constants.js";

// 解析命令行参数
const args = process.argv.slice(2);
const start = args[0] || getCurrentMonth();
const end = args[1] || start;

try {
  // 同步当月交易记录
  const { startDate, endDate } = getDefaultDateRange();
  console.log(`同步范围：${startDate} ~ ${endDate}`);

  // 清理脏数据：删除同步窗口内过户费为 0 的记录（接口费用数据有误的历史快照），
  // 随后 syncTrade 会立即重拉补回；范围限定当月，避免丢失历史记录
  const ym = `${startDate.substring(0, 4)}-${startDate.substring(4, 6)}`;
  await withDb(async (db) => {
    const delZeroFee = async (table, where, label) => {
      const rows = await db.all(`SELECT count(*) AS n FROM ${table} WHERE ${where}`);
      const n = Number(rows[0]?.n ?? 0);
      if (n > 0) {
        await db.run(`DELETE FROM ${table} WHERE ${where}`);
        console.log(`已清理${label}（过户费=0）: ${n} 条`);
      }
    };
    await delZeroFee(
      TABLE.TRADE_RECORD,
      `transfer_fee = 0 AND substr(entry_date, 1, 7) = '${ym}'`,
      "当月交易记录",
    );
    await delZeroFee(
      TABLE.TRADE_MATCHED,
      `(sell_transfer_fee = 0 OR buy_transfer_fee = 0) AND strftime(sell_time, '%Y-%m') = '${ym}'`,
      "当月匹配记录",
    );
  });

  await syncTrade(startDate, endDate);

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