/**
 * SQL 交易匹配相关定义
 * 包含交易记录匹配的 SQL
 */

import { TABLE, OP } from "./constants.js";

/**
 * 一键批量匹配 - 分两步执行
 * 第一步：获取所有潜在匹配对（每个卖出只取最近一个买入）
 * 第二步：在应用层去重后插入
 */
export const TRADE_MATCH = `
  WITH unmatched_sells AS (
    SELECT t1.account_id, t1.account_name, t1.code, t1.name,
      t1.entry_price AS sell_entry_price, t1.entry_count AS sell_entry_count,
      t1.entry_money AS sell_entry_money, t1.transfer_fee AS sell_transfer_fee,
      IF(t1.entry_money = t1.transfer_fee, t1.entry_money, t1.entry_money - t1.transfer_fee) AS sell_moneychg,
      CAST(t1.entry_date_time AS TIMESTAMP) AS sell_time,
      t1.history_id AS sell_history_id
    FROM ${TABLE.TRADE_RECORD} t1 WHERE t1.op = ${OP.SELL}
      AND t1.history_id NOT IN (SELECT sell_history_id FROM ${TABLE.TRADE_MATCHED})
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
    INNER JOIN ${TABLE.TRADE_RECORD} bb ON bb.op = ${OP.BUY}
      AND bb.account_id = us.account_id AND bb.code = us.code
      AND bb.entry_count = us.sell_entry_count
      AND CAST(bb.entry_date_time AS TIMESTAMP) <= us.sell_time
      AND bb.history_id NOT IN (SELECT buy_history_id FROM ${TABLE.TRADE_MATCHED})
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
  WHERE sell_rank = 1 AND buy_rank = 1;`;

/**
 * 查询未匹配买入记录
 */
export const QUERY_UNMATCHED_BUY = `
  SELECT 
    r.account_name, r.code, r.name, r.op_name,
    r.entry_price, r.entry_count, r.entry_money,
    r.entry_date, r.entry_time
  FROM ${TABLE.TRADE_RECORD} r
  LEFT JOIN ${TABLE.TRADE_MATCHED} m ON r.history_id = m.buy_history_id
  WHERE m.buy_history_id IS NULL AND r.op = ${OP.BUY}
  ORDER BY r.entry_date, r.entry_time`;

/**
 * 查询未匹配卖出记录
 */
export const QUERY_UNMATCHED_SELL = `
  SELECT 
    r.account_name, r.code, r.name, r.op_name,
    r.entry_price, r.entry_count, r.entry_money,
    r.entry_date, r.entry_time
  FROM ${TABLE.TRADE_RECORD} r
  LEFT JOIN ${TABLE.TRADE_MATCHED} m ON r.history_id = m.sell_history_id
  WHERE m.sell_history_id IS NULL AND r.op = ${OP.SELL}
  ORDER BY r.entry_date, r.entry_time`;
