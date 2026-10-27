#!/usr/bin/env node

/**
 * 重置匹配记录并按新逻辑重新匹配
 * 用法: node reset-match.js [--db <path>] [--strategy lifo|fifo|psf|all]
 * 
 * ⚠️ 此脚本会清空所有匹配记录并重新匹配，用于匹配逻辑变更后重建配对
 * --strategy 匹配策略：lifo=后入先出，fifo=先入先出，psf=价差最小优先，all=三种都跑（默认）
 */

import { withDb } from "./db.js";
import { TABLE } from "./constants.js";
import { tradeMatch } from "./business.js";
import { renderMatchStats } from "./utils.js";
import { extractDbFlag } from "./db.js";

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
  await withDb(async (db) => {
    // 1. 清空匹配记录表
    console.log("正在清空匹配记录表...");
    await db.run(`DELETE FROM ${TABLE.TRADE_MATCHED}`);
    const countResult = await db.all(`SELECT count() AS cnt FROM ${TABLE.TRADE_MATCHED}`);
    console.log(`已清空，当前 ${countResult[0].cnt} 条记录`);
  });

  // 2. 重新匹配
  const strategies = strategy === 'all' ? ['lifo', 'fifo', 'psf'] : [strategy];
  for (const s of strategies) {
    console.log(`\n按 ${STRATEGY_LABEL[s]} 匹配...`);
    const result = await tradeMatch({ strategy: s });
    console.log(renderMatchStats(result));
  }
  console.log("\n重置匹配完成");
} catch (e) {
  console.error("重置匹配失败:", e.message);
  process.exit(1);
}
