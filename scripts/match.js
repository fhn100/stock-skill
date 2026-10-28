#!/usr/bin/env node

/**
 * 独立匹配脚本 - 不依赖 opencli
 * 用法: node match.js [--db <path>] [--strategy lifo|fifo|psf|all]
 * 只对本地库中未匹配的买卖记录做配对；同步新交易记录请先执行 `opencli stock sync-tzzb`
 * --db 为 STOCK_DB_OVERRIDE 的命令行糖（隔离测试用，默认 ~/.duckdb/stock/stock.db）
 * --strategy 匹配策略：lifo=后入先出，fifo=先入先出，psf=价差最小优先，all=三种都跑（默认）
 */

import { tradeMatch } from "./business.js";
import { extractDbFlag } from "./db.js";
import { renderMatchStats } from "./utils.js";

const args = process.argv.slice(2);
extractDbFlag(args);

// 解析 --strategy 参数
let strategy = 'all';
const strategyIdx = args.indexOf('--strategy');
if (strategyIdx !== -1 && args[strategyIdx + 1]) {
  strategy = args[strategyIdx + 1];
  if (!['lifo', 'fifo', 'psf', 'all'].includes(strategy)) {
    console.error(`错误: --strategy 必须是 lifo/fifo/psf/all，当前: ${strategy}`);
    process.exit(1);
  }
}

const STRATEGY_LABEL = {
  lifo: 'LIFO（后入先出，成交配对视图）',
  fifo: 'FIFO（先入先出，盈亏计算视图）',
  psf: 'PSF（价差最小优先，不限时间）',
};

try {
  const strategies = strategy === 'all' ? ['lifo', 'fifo', 'psf'] : [strategy];
  for (const s of strategies) {
    console.log(`使用匹配策略: ${STRATEGY_LABEL[s]}`);
    console.log(renderMatchStats(await tradeMatch({ strategy: s })));
  }

  console.log("\n匹配交易记录完成");
} catch (e) {
  console.error("匹配交易记录失败:", e.message);
  process.exit(1);
}
