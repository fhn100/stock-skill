/**
 * SQL 交易匹配相关定义
 * 使用网格交易匹配算法：
 * 优先匹配时间最近的买入，排除已匹配记录
 */

import { TABLE, OP } from "./constants.js";

/**
 * 交易匹配 SQL - 网格专用算法
 * 匹配逻辑：
 * 1. 时间最近优先：持有天数越短越优先（卖出时间 - 买入时间 ASC）
 * 2. 排除已匹配记录
 */
export const TRADE_MATCH_GRID = `
  INSERT INTO ${TABLE.TRADE_MATCHED}
  SELECT
    t.account_id, t.account_name,
    STRFTIME(t.sell_time, '%Y'), STRFTIME(t.sell_time, '%Y-%m'),
    t.code, t.name,
    t.sell_entry_price, t.buy_entry_price,
    t.sell_entry_count, t.buy_entry_count,
    t.sell_entry_money, t.buy_entry_money,
    t.sell_transfer_fee, t.buy_transfer_fee,
    t.sell_moneychg - t.buy_moneychg,
    t.sell_time, t.buy_time,
    t.sell_history_id, t.buy_history_id
  FROM (
    SELECT *,
      ROW_NUMBER() OVER (PARTITION BY t.sell_history_id ORDER BY t.days_diff ASC) AS sell_seq,
      ROW_NUMBER() OVER (PARTITION BY t.buy_history_id ORDER BY t.days_diff ASC) AS buy_seq
    FROM (
      SELECT
        t1.account_id, t1.account_name, t1.code, t1.name,
        t1.entry_price AS sell_entry_price, t2.entry_price AS buy_entry_price,
        t1.entry_count AS sell_entry_count, t2.entry_count AS buy_entry_count,
        t1.entry_money AS sell_entry_money, t2.entry_money AS buy_entry_money,
        t1.transfer_fee AS sell_transfer_fee, t2.transfer_fee AS buy_transfer_fee,
        t1.moneychg AS sell_moneychg, t2.moneychg AS buy_moneychg,
        t1.entry_date_time AS sell_time, t2.entry_date_time AS buy_time,
        t1.history_id AS sell_history_id, t2.history_id AS buy_history_id,
        -- 计算持有天数（DuckDB: date_diff 返回整数天数）
        date_diff('day', t2.entry_date_time, t1.entry_date_time) AS days_diff,
        ABS(t1.entry_price - t2.entry_price) AS price_diff
      FROM (
        SELECT
          t.account_id, t.account_name, t.code, t.name,
          t.entry_price, t.entry_count, t.entry_money, t.transfer_fee,
          IF(t.entry_money = t.transfer_fee, t.entry_money, t.entry_money - t.transfer_fee) AS moneychg,
          CAST(t.entry_date_time AS TIMESTAMP) AS entry_date_time,
          t.history_id
        FROM ${TABLE.TRADE_RECORD} t WHERE t.op = ${OP.SELL}
      ) t1
      INNER JOIN (
        SELECT
          t.account_id, t.account_name, t.code, t.name,
          t.entry_price, t.entry_count, t.entry_money, t.transfer_fee,
          IF(t.entry_money = t.transfer_fee, t.entry_money, t.entry_money + t.transfer_fee) AS moneychg,
          CAST(t.entry_date_time AS TIMESTAMP) AS entry_date_time,
          t.history_id
        FROM ${TABLE.TRADE_RECORD} t WHERE t.op = ${OP.BUY}
      ) t2
      ON t2.account_id = t1.account_id AND t2.code = t1.code
         AND t2.entry_count = t1.entry_count
         -- 买入时间早于卖出时间
         AND t2.entry_date_time <= t1.entry_date_time
    ) t
    -- 排除已匹配的记录（卖出和买入都要排除，避免同一买入被多个卖出重复使用）
    LEFT JOIN (SELECT sell_history_id FROM ${TABLE.TRADE_MATCHED}) t2 ON t2.sell_history_id = t.sell_history_id
    LEFT JOIN (SELECT buy_history_id FROM ${TABLE.TRADE_MATCHED}) t3 ON t3.buy_history_id = t.buy_history_id
    WHERE t2.sell_history_id IS NULL AND t3.buy_history_id IS NULL
  ) t
  -- 双向约束：卖出只选持有天数最短的买入，且该买入也只被它选为最短（保证一对一）
  WHERE t.sell_seq = 1 AND t.buy_seq = 1;`;

/**
 * 查询未匹配记录
 */
export const QUERY_UNMATCHED = `
  SELECT 
    r.account_name, r.code, r.name, r.op_name,
    r.entry_price, r.entry_count, r.entry_money,
    r.entry_date, r.entry_time,
    '未匹配' as status
  FROM ${TABLE.TRADE_RECORD} r
  LEFT JOIN ${TABLE.TRADE_MATCHED} m ON r.history_id = m.buy_history_id
  WHERE m.buy_history_id IS NULL AND r.op = ${OP.BUY}
  UNION ALL
  SELECT 
    r.account_name, r.code, r.name, r.op_name,
    r.entry_price, r.entry_count, r.entry_money,
    r.entry_date, r.entry_time,
    '未匹配' as status
  FROM ${TABLE.TRADE_RECORD} r
  LEFT JOIN ${TABLE.TRADE_MATCHED} m ON r.history_id = m.sell_history_id
  WHERE m.sell_history_id IS NULL AND r.op = ${OP.SELL}`;

/**
 * 统计未匹配记录
 */
export const QUERY_UNMATCHED_COUNT = `
  SELECT 
    (SELECT COUNT(*) FROM ${TABLE.TRADE_RECORD} r
     LEFT JOIN ${TABLE.TRADE_MATCHED} m ON r.history_id = m.buy_history_id
     WHERE m.buy_history_id IS NULL AND op = ${OP.BUY}) as buy_unmatched,
    (SELECT COUNT(*) FROM ${TABLE.TRADE_RECORD} r
     LEFT JOIN ${TABLE.TRADE_MATCHED} m ON r.history_id = m.sell_history_id
     WHERE m.sell_history_id IS NULL AND op = ${OP.SELL}) as sell_unmatched`;

/**
 * 查询未匹配买入记录（拆分版，供 getUnmatchedBuys 使用）
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
 * 查询未匹配卖出记录（拆分版，供 getUnmatchedSells 使用）
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
