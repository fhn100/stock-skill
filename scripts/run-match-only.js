#!/usr/bin/env node

/**
 * 仅执行匹配（不同步） - 清空匹配表后重新匹配所有交易记录
 * 用法: node run-match-only.js
 * 注意：必须用 db.js 的 withDb（单例连接），不能自己创建 DuckDBInstance，
 * 否则同一文件两个 instance 会导致写入在退出后丢失。
 */

import { tradeMatch, } from "./business.js";
import { withDb, getDbPath } from "./db.js";

console.log("数据库路径:", getDbPath());

// 清空匹配表（用 withDb 复用单例连接）
const before = await withDb(async (conn) => {
  const r = await conn.all(`SELECT count(*) AS c FROM t_trade_matched_record`);
  return r[0].c;
});
console.log(`清空前匹配记录数: ${before}`);

await withDb(async (conn) => {
  await conn.run(`DELETE FROM t_trade_matched_record`);
});
console.log("已清空 t_trade_matched_record");

// 重新匹配
await tradeMatch();
console.log("重新匹配完成");
