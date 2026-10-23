#!/usr/bin/env node

/**
 * 独立匹配脚本 - 不依赖 opencli
 * 用法: node match.js [--db <path>]
 * 只对本地库中未匹配的买卖记录做配对；同步新交易记录请先执行 `opencli stock sync`
 * --db 为 STOCK_DB_OVERRIDE 的命令行糖（隔离测试用，默认 ~/.duckdb/stock/stock.db）
 */

import { tradeMatch } from "./business.js";
import { extractDbFlag } from "./db.js";
import { renderMatchStats } from "./utils.js";

extractDbFlag(process.argv.slice(2));

try {
  // 匹配交易记录（先买后卖，仅盈利）
  console.log(renderMatchStats(await tradeMatch()));

  console.log("\n匹配交易记录完成");
} catch (e) {
  console.error("匹配交易记录失败:", e.message);
  process.exit(1);
}
