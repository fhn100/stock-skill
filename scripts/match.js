#!/usr/bin/env node

/**
 * 独立匹配脚本 - 不依赖 opencli
 * 用法: node match.js
 * 只对本地库中未匹配的买卖记录做配对；同步新交易记录请先执行 `opencli stock sync`
 */

import { tradeMatch } from "./business.js";

try {
  // 匹配交易记录（先买后卖，仅盈利）
  await tradeMatch();

  console.log("\n匹配交易记录完成");
} catch (e) {
  console.error("匹配交易记录失败:", e.message);
  process.exit(1);
}
