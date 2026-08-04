/**
 * 业务逻辑层
 * 包含交易同步、匹配、收益查询等核心业务逻辑
 */

import { withDb } from "./db.js";
import { TABLE, OP, PAGE_SIZE, API_BASE, API_PATH, HTTP_HEADERS, API_DEFAULTS, DICT_TYPE, SYNC_CONCURRENCY } from "./constants.js";
import { getCookie, getUserId, checkCookieValid } from "./utils.js";
import { 
  QUERY_UNMATCHED_BUY, QUERY_UNMATCHED_SELL
} from "./sql-match.js";
import { 
  GRID_PROFIT
} from "./sql-profit.js";
import {
  CREATE_DICT, CREATE_TRADE_RECORD, CREATE_TRADE_MATCHED
} from "./sql-schema.js";
import { INSERT_ACCOUNT, INSERT_TRADE } from "./sql-sync.js";
import { SQL } from "./db.js";

// ============================ HTTP 请求工具 ============================

/**
 * 发起 POST 请求（同花顺财神平台 API）
 * @param {string} url - 请求 URL
 * @param {Object} params - 表单参数
 * @param {string} cookie - Cookie
 * @returns {Promise<Object>} JSON 响应
 */
async function postForm(url, params, cookie) {
  const formData = new URLSearchParams(params);
  const headers = {
    ...HTTP_HEADERS,
    cookie,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return await response.json();
}

// ============================ 数据库初始化 ============================

/** 初始化数据库表结构 */
export async function initDb() {
  await withDb(async (conn) => {
    for (const [name, sql] of Object.entries({
      "字典表": CREATE_DICT,
      "交易记录表": CREATE_TRADE_RECORD,
      "交易匹配表": CREATE_TRADE_MATCHED,
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

  // 调用 API 获取账户列表
  const url = `${API_BASE}${API_PATH.ACCOUNT_LIST}`;
  const params = {
    userid: userId,
    user_id: userId,
    terminal: API_DEFAULTS.TERMINAL,
    version: API_DEFAULTS.VERSION,
  };

  const data = await postForm(url, params, cookie);

  // 解析响应并插入数据库
  const common = data?.ex_data?.common || [];
  await withDb(async (conn) => {
    for (const item of common) {
      const fundKey = item.fund_key;
      const manualName = item.manualname;
      if (fundKey) {
        await conn.run(INSERT_ACCOUNT, [fundKey, manualName]);
      }
    }
  });

  console.log("同步账户成功, 共同步", common.length, "条记录");
}

// ============================ 交易记录同步 ============================

/**
 * 按基金KEY同步交易记录（自动分页，带重试）
 * @param {string} fundKey - 基金KEY
 * @param {string} startDate - 开始日期 YYYYMMDD
 * @param {string} endDate - 结束日期 YYYYMMDD
 * @param {number} [page=1] - 页码
 * @param {number} [retryCount=3] - 剩余重试次数
 * @returns {Promise<number>} 同步的记录数
 */
export async function syncTradeByFundKey(fundKey, startDate, endDate, page = 1, retryCount = 3) {
  try {
    checkCookieValid();
    const cookie = getCookie();
    const userId = getUserId();

    // 调用 API 获取交易记录
    const url = `${API_BASE}${API_PATH.SYNC_TRADE}`;
    const params = {
      userid: userId,
      user_id: userId,
      fund_key: fundKey,
      stock_code: '',
      stock_account: '',
      start_date: startDate,
      end_date: endDate,
      page: page.toString(),
      count: PAGE_SIZE.toString(),
      sort_type: '',
      sort_order: '1',
    };

    const data = await postForm(url, params, cookie);
    const exData = data?.ex_data || {};
    const maxPage = exData.max_page || 1;
    const list = exData.list || [];

    // 获取账户名称
    let accountName = '';
    await withDb(async (conn) => {
      const rows = await conn.all(
        `SELECT value FROM ${TABLE.DICT} WHERE key = ? AND type = '${DICT_TYPE.FUND_KEY}'`,
        [fundKey]
      );
      accountName = rows[0]?.value || '';
    });

    // 解析响应并批量插入数据库
    const rows = list.map(item => {
      const entryDateTime = `${item.entry_date} ${item.entry_time}`;
      const entryEpoch = Math.floor(new Date(entryDateTime).getTime() / 1000);
      const historyId = `${item.account_id}${entryEpoch}${item.code}${item.op}${item.entry_count}`;

      return [
        item.account_id,
        accountName,
        item.account_type,
        item.code,
        parseFloat(item.commission) || 0,
        parseFloat(item.entry_cost) || 0,
        item.entry_count,
        item.entry_date,
        parseFloat(item.entry_money) || 0,
        parseFloat(item.entry_price) || 0,
        item.entry_time,
        entryDateTime,
        parseFloat(item.fee_total) || 0,
        historyId,
        item.manual_id,
        item.market_code,
        item.name,
        parseInt(item.oid) || 0,
        item.op,
        item.op_name,
        parseFloat(item.transfer_fee) || 0,
      ];
    });

    await withDb(async (conn) => {
      for (const row of rows) {
        await conn.run(INSERT_TRADE, row);
      }
    });

    const n = list.length;
    console.log(`同步交易记录成功, 账户: ${fundKey}, 页: ${page}/${maxPage}, 记录数: ${n}`);

    if (page < maxPage) {
      await syncTradeByFundKey(fundKey, startDate, endDate, page + 1, retryCount);
    }

    return n;
  } catch (error) {
    if (retryCount > 1) {
      console.warn(`同步交易记录失败, 账户: ${fundKey}, 页: ${page}, 重试中... (${retryCount - 1}/${3})`);
      await new Promise(r => setTimeout(r, 1000));
      return await syncTradeByFundKey(fundKey, startDate, endDate, page, retryCount - 1);
    }
    throw error;
  }
}

/**
 * 同步单个账户（带错误捕获）
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
 * 账户从 t_dict 表读取（type=fund_key），不再依赖 gtja-api.js / t_dict_account
 * @param {string} startDate - 开始日期 YYYYMMDD
 * @param {string} endDate - 结束日期 YYYYMMDD
 * @param {number} [concurrency=3] - 并发数
 */
export async function syncTrade(startDate, endDate, concurrency = SYNC_CONCURRENCY) {
  await withDb(async (conn) => {
    await conn.run(CREATE_DICT);
    await conn.run(CREATE_TRADE_RECORD);
    await conn.run(CREATE_TRADE_MATCHED);
  });

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

/**
 * 匹配交易记录（循环直到无可匹配记录）
 */
export async function tradeMatch() {
  await withDb(async (conn) => {
    let total = 0;
    let iterations = 0;
    const MAX_ITERATIONS = 100;

    while (iterations < MAX_ITERATIONS) {
      const result = await conn.run(SQL.TRADE_MATCH_GRID);
      // @duckdb/node-api 的 run() 返回 DuckDBMaterializedResult，行数为 rowsChanged（rowsAffected 不存在）
      const affected = result?.rowsChanged || 0;
      if (affected === 0) break;
      total += affected;
      iterations++;
      console.log(`匹配交易记录成功, 本轮匹配 ${affected} 条`);
    }

    if (iterations >= MAX_ITERATIONS) {
      console.warn(`匹配达到安全上限 ${MAX_ITERATIONS} 次，可能存在异常数据`);
    }

    console.log(`匹配交易记录完成，本次共新增 ${total} 条匹配`);
  });
}

// ============================ 收益查询 ============================

/**
 * 查询网格收益
 * @param {string} startMonth - 开始月份 YYYY-MM
 * @param {string} endMonth - 结束月份 YYYY-MM
 */
export async function gridProfit(startMonth = '2026-01', endMonth = '2026-12') {
  return await withDb(async (conn) => {
    return await conn.all(GRID_PROFIT, [endMonth, startMonth, endMonth, startMonth.substring(0, 4)]);
  });
}

/**
 * 查询股票交易明细
 * @param {string} code - 股票代码
 * @param {string} startDate - 开始日期
 * @param {string} endDate - 结束日期
 */
export async function getTradeDetails(code, startDate = '', endDate = '') {
  return await withDb(async (conn) => {
    let sql = `
      SELECT 
        r.account_name, r.code, r.name, r.op,
        r.entry_price, r.entry_count, r.entry_money, r.transfer_fee,
        r.entry_date, r.entry_time,
        m.profit as match_profit
      FROM t_trade_record r
      LEFT JOIN t_trade_matched_record m ON r.history_id = m.buy_history_id OR r.history_id = m.sell_history_id
      WHERE r.code = ?
    `;
    
    const params = [code];
    
    if (startDate) {
      sql += ' AND r.entry_date >= ?';
      params.push(startDate);
    }
    
    if (endDate) {
      sql += ' AND r.entry_date <= ?';
      params.push(endDate);
    }
    
    sql += ' ORDER BY r.entry_date, r.entry_time';
    
    return await conn.all(sql, params);
  });
}

/**
 * 查询未匹配买入记录
 */
export async function getUnmatchedBuys() {
  return await withDb(async (conn) => {
    return await conn.all(QUERY_UNMATCHED_BUY);
  });
}

/**
 * 查询未匹配卖出记录
 */
export async function getUnmatchedSells() {
  return await withDb(async (conn) => {
    return await conn.all(QUERY_UNMATCHED_SELL);
  });
}
