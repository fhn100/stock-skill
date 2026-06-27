import { getCookie, getUserId, checkCookieValid } from "./utils.js";
import { TABLE, PAGE_SIZE, DICT_TYPE, SYNC_CONCURRENCY, MATCH_MAX_ITERATIONS } from "./constants.js";
import { SQL, withDb } from "./db.js";

// ============================ 数据库初始化 ============================

/** 初始化数据库表结构 */
export async function initDb() {
  await withDb(async (conn) => {
    for (const [name, sql] of Object.entries({
      "字典表": SQL.CREATE_DICT,
      "交易记录表": SQL.CREATE_TRADE_RECORD,
      "交易匹配表": SQL.CREATE_TRADE_MATCHED,
    })) {
      await conn.run(sql);
      console.log(`${name}初始化成功`);
    }
  });
}

// ============================ 账户同步 ============================

/** 同步账户信息到字典表 */
export async function initAccount() {
  checkCookieValid();
  const cookie = getCookie();
  const userId = getUserId();

  const count = await withDb(async (_conn, stmt) => {
    const rows = await stmt.all(cookie, userId, userId);
    return rows[0]?.Count || 0;
  }, SQL.SYNC_ACCOUNT);

  console.log("同步账户成功, 共同步", count, "条记录");
}

// ============================ 交易记录同步 ============================

/**
 * 按基金KEY同步交易记录（自动分页）
 * @param {string} fundKey - 基金KEY
 * @param {string} startDate - 开始日期 YYYYMMDD
 * @param {string} endDate - 结束日期 YYYYMMDD
 * @param {number} [page=1] - 页码
 * @returns {Promise<number>} 同步的记录数
 */
export async function syncTradeByFundKey(fundKey, startDate, endDate, page = 1) {
  checkCookieValid();
  const cookie = getCookie();
  const userId = getUserId();

  const count = await withDb(async (_conn, stmt) => {
    const rows = await stmt.all(cookie, userId, userId, fundKey, startDate, endDate, page);
    const n = rows[0]?.Count || 0;
    console.log(`同步交易记录成功, 账户: ${fundKey}, 页: ${page}, 记录数: ${n}`);
    return n;
  }, SQL.SYNC_TRADE);

  if (count >= PAGE_SIZE) {
    await syncTradeByFundKey(fundKey, startDate, endDate, page + 1);
  }

  return count;
}

/**
 * 同步单个账户（带错误捕获）
 * @param {string} fundKey - 基金 KEY
 * @param {string} startDate - 开始日期
 * @param {string} endDate - 结束日期
 * @returns {Promise<{fundKey: string, success: boolean, error?: string}>} 结果对象
 */
async function syncSingleAccount(fundKey, startDate, endDate) {
  try {
    await syncTradeByFundKey(fundKey, startDate, endDate);
    return { fundKey, success: true };
  } catch (error) {
    console.error(`账户 ${fundKey} 同步失败:`, error.message);
    return { fundKey, success: false, error: error.message };
  }
}

/**
 * 同步一批账户（并行处理）
 * @param {string[]} fundKeys - 基金 KEY 列表
 * @param {string} startDate - 开始日期
 * @param {string} endDate - 结束日期
 * @returns {Promise<{successCount: number, failCount: number}>} 本批次统计
 */
async function syncBatch(fundKeys, startDate, endDate) {
  const results = await Promise.all(
    fundKeys.map((fk) => syncSingleAccount(fk, startDate, endDate))
  );

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;

  if (failCount > 0) {
    console.warn(`本批次 ${fundKeys.length} 个账户: ${successCount} 成功, ${failCount} 失败`);
  }

  return { successCount, failCount };
}

/**
 * 同步所有账户的交易记录（并行分批处理）
 * @param {string} startDate - 开始日期 YYYYMMDD
 * @param {string} endDate - 结束日期 YYYYMMDD
 * @param {number} [concurrency=3] - 并发数
 */
export async function syncTrade(startDate, endDate, concurrency = SYNC_CONCURRENCY) {
  const fundKeys = await withDb(async (conn) => {
    const rows = await conn.all(`SELECT key FROM ${TABLE.DICT} WHERE type = '${DICT_TYPE.FUND_KEY}'`);
    return rows.map((row) => row.key);
  });

  console.log(`开始同步 ${fundKeys.length} 个账户，并发数: ${concurrency}`);

  for (let i = 0; i < fundKeys.length; i += concurrency) {
    await syncBatch(fundKeys.slice(i, i + concurrency), startDate, endDate);
  }

  console.log("所有账户交易记录同步完成");
}

// ============================ 交易匹配 ============================

/** 匹配交易记录（循环直到无可匹配记录） */
export async function tradeMatch() {
  await withDb(async (conn) => {
    let total = 0;
    let count = -1;
    let iterations = 0;
    while (count !== 0 && iterations < MATCH_MAX_ITERATIONS) {
      const rows = await conn.all(SQL.TRADE_MATCH);
      count = Number(rows[0]?.Count) || 0;
      total += count;
      iterations++;
      if (count > 0) console.log(`匹配交易记录成功, 本轮匹配 ${count} 条`);
    }
    if (iterations >= MATCH_MAX_ITERATIONS && count !== 0) {
      console.warn(`匹配达到安全上限 ${MATCH_MAX_ITERATIONS} 次，可能存在异常数据`);
    }
    console.log(`匹配交易记录完成，本次共新增 ${total} 条匹配`);
  });
}

// ============================ 收益查询 ============================

/**
 * 查询网格收益
 * @param {string} startMonth - 开始月份 YYYY-MM
 * @param {string} endMonth - 结束月份 YYYY-MM
 * @returns {Promise<Array>} 收益数据数组
 */
export async function gridProfit(startMonth, endMonth) {
  return await withDb(async (_conn, stmt) => {
    return await stmt.all(endMonth, startMonth, endMonth, startMonth);
  }, SQL.GRID_PROFIT);
}
