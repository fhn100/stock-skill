/**
 * 业务逻辑层
 * 包含交易同步、匹配、收益查询等核心业务逻辑
 */

import { withDb } from "./db.js";
import { TABLE, OP } from "./constants.js";
import { 
  QUERY_UNMATCHED_BUY, QUERY_UNMATCHED_SELL
} from "./sql-match.js";
import { 
  GRID_PROFIT
} from "./sql-profit.js";
import {
  CREATE_DICT, CREATE_TRADE_RECORD, CREATE_TRADE_MATCHED
} from "./sql-schema.js";

// 匹配最大迭代次数，防止死循环
const MATCH_MAX_ITERATIONS = 100;

// ============================ 交易同步 ============================

/**
 * 同步交易记录
 * @param {string} startDate - 开始日期 YYYYMMDD
 * @param {string} endDate - 结束日期 YYYYMMDD
 */
export async function syncTrade(startDate = '20260101', endDate = '20261231') {
  console.log(`同步范围：${startDate} ~ ${endDate}`);
  
  await withDb(async (conn) => {
    // 创建表（使用 sql-schema.js 中 DuckDB 兼容的定义）
    await conn.run(CREATE_DICT);
    await conn.run(CREATE_TRADE_RECORD);
    await conn.run(CREATE_TRADE_MATCHED);
    
    // 获取账户列表
    const accounts = await conn.all('SELECT * FROM t_dict_account');
    console.log(`开始同步 ${accounts.length} 个账户，并发数: ${Math.min(accounts.length, 3)}`);
    
    // 并发同步
    const results = await Promise.allSettled(
      accounts.map(async (acc) => {
        try {
          const { syncAccountTrade } = await import("./gtja-api.js");
          const result = await syncAccountTrade(acc.account_id, startDate, endDate, 100);
          console.log(`同步交易记录成功, 账户: ${acc.account_id}, 页: ${result.page}/${result.totalPages}, 记录数: ${result.count}`);
          return result;
        } catch (e) {
          console.error(`同步账户 ${acc.account_id} 失败:`, e.message);
          return null;
        }
      })
    );
    
    // 汇总结果
    const totalRecords = results
      .filter(r => r.status === 'fulfilled' && r.value !== null)
      .reduce((sum, r) => sum + r.value.count, 0);
    
    console.log(`所有账户交易记录同步完成，共 ${totalRecords} 条`);
  });
}

// ============================ 交易匹配 ============================

/**
 * 匹配交易记录（循环直到无可匹配记录）
 */
export async function tradeMatch() {
  await withDb(async (conn) => {
    let total = 0;
    let iterations = 0;
    
    while (iterations < MATCH_MAX_ITERATIONS) {
      // 获取潜在匹配对
      const potential = await conn.all(`
        WITH unmatched_sells AS (
          SELECT t1.account_id, t1.account_name, t1.code, t1.name,
            t1.entry_price AS sell_entry_price, t1.entry_count AS sell_entry_count,
            t1.entry_money AS sell_entry_money, t1.transfer_fee AS sell_transfer_fee,
            IF(t1.entry_money = t1.transfer_fee, t1.entry_money, t1.entry_money - t1.transfer_fee) AS sell_moneychg,
            CAST(t1.entry_date_time AS TIMESTAMP) AS sell_time,
            t1.history_id AS sell_history_id
          FROM t_trade_record t1 WHERE t1.op = '2'
            AND t1.history_id NOT IN (SELECT sell_history_id FROM t_trade_matched_record)
        ),
        ranked_matches AS (
          SELECT us.account_id, us.account_name, us.code, us.name,
            us.sell_entry_price, bb.entry_price AS buy_entry_price,
            us.sell_entry_count, bb.entry_count AS buy_entry_count,
            us.sell_entry_money, bb.entry_money AS buy_entry_money,
            us.sell_transfer_fee, bb.transfer_fee AS buy_transfer_fee,
            us.sell_moneychg - IF(bb.entry_money = bb.transfer_fee, bb.entry_money, bb.entry_money + bb.transfer_fee) AS profit,
            us.sell_time, CAST(bb.entry_date_time AS TIMESTAMP) AS buy_time,
            us.sell_history_id, bb.history_id AS buy_history_id,
            ROW_NUMBER() OVER (PARTITION BY us.sell_history_id ORDER BY bb.entry_date_time DESC) AS sell_rank,
            ROW_NUMBER() OVER (PARTITION BY bb.history_id ORDER BY us.sell_time DESC) AS buy_rank
          FROM unmatched_sells us
          INNER JOIN t_trade_record bb ON bb.op = '1'
            AND bb.account_id = us.account_id AND bb.code = us.code
            AND bb.entry_count = us.sell_entry_count
            AND CAST(bb.entry_date_time AS TIMESTAMP) <= us.sell_time
            AND bb.history_id NOT IN (SELECT buy_history_id FROM t_trade_matched_record)
        )
        SELECT account_id, account_name,
          STRFTIME(sell_time, '%Y') as year, STRFTIME(sell_time, '%Y-%m') as month,
          code, name,
          sell_entry_price, buy_entry_price,
          sell_entry_count, buy_entry_count,
          sell_entry_money, buy_entry_money,
          sell_transfer_fee, buy_transfer_fee,
          profit, sell_time, buy_time,
          sell_history_id, buy_history_id
        FROM ranked_matches
        WHERE sell_rank = 1 AND buy_rank = 1
      `);
      
      if (potential.length === 0) break;
      
      // 在应用层去重：每个买入只能匹配一个卖出，每个卖出只能匹配一个买入
      const matchedBuys = new Set();
      const matchedSells = new Set();
      const unique = [];
      
      for (const row of potential) {
        if (!matchedBuys.has(row.buy_history_id) && !matchedSells.has(row.sell_history_id)) {
          matchedBuys.add(row.buy_history_id);
          matchedSells.add(row.sell_history_id);
          unique.push(row);
        }
      }
      
      if (unique.length === 0) break;
      
      // 批量插入
      for (const row of unique) {
        await conn.run(`INSERT INTO t_trade_matched_record VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
          row.account_id, row.account_name, row.year, row.month,
          row.code, row.name, row.sell_entry_price, row.buy_entry_price,
          row.sell_entry_count, row.buy_entry_count, row.sell_entry_money, row.buy_entry_money,
          row.sell_transfer_fee, row.buy_transfer_fee, row.profit, row.sell_time, row.buy_time,
          row.sell_history_id, row.buy_history_id
        ]);
      }
      
      total += unique.length;
      iterations++;
      
      if (unique.length > 0) {
        console.log(`匹配交易记录成功, 本轮匹配 ${unique.length} 条`);
      }
    }
    
    if (iterations >= MATCH_MAX_ITERATIONS) {
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
