/**
 * SQL 交易匹配相关定义
 * 包含交易记录匹配的 SQL
 */

import { TABLE, OP } from "./constants.js";

/**
 * 交易匹配 SQL
 * 将买入和卖出记录按 account_id + code + entry_count 配对
 * 使用时间序列分析确保买入时间早于卖出时间
 *
 * 匹配逻辑：
 * 1. 筛选卖出记录 (op=2) 和买入记录 (op=1)
 * 2. 按 account_id + code + entry_count 关联
 * 3. 确保买入时间早于卖出时间
 * 4. 使用 ROW_NUMBER() 确保每个记录只匹配一次
 * 5. 排除已匹配的记录
 */
export const TRADE_MATCH = `
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
    SELECT *, ROW_NUMBER() OVER (PARTITION BY t.sell_history_id ORDER BY t.trans_times_sub) AS sell_seq,
              ROW_NUMBER() OVER (PARTITION BY t.buy_history_id ORDER BY t.trans_times_sub) AS buy_seq
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
        t1.trans_times - t2.trans_times AS trans_times_sub
      FROM (
        SELECT
          t.account_id, t.account_name, t.code, t.name,
          t.entry_price, t.entry_count, t.entry_money, t.transfer_fee,
          IF(t.entry_money = t.transfer_fee, t.entry_money, t.entry_money - t.transfer_fee) AS moneychg,
          CAST(t.entry_date_time AS TIMESTAMP) AS entry_date_time,
          t.history_id,
          EPOCH(CAST(t.entry_date_time AS TIMESTAMP)) AS trans_times
        FROM ${TABLE.TRADE_RECORD} t WHERE t.op = ${OP.SELL}
      ) t1
      INNER JOIN (
        SELECT
          t.account_id, t.account_name, t.code, t.name,
          t.entry_price, t.entry_count, t.entry_money, t.transfer_fee,
          IF(t.entry_money = t.transfer_fee, t.entry_money, t.entry_money + t.transfer_fee) AS moneychg,
          CAST(t.entry_date_time AS TIMESTAMP) AS entry_date_time,
          t.history_id,
          EPOCH(CAST(t.entry_date_time AS TIMESTAMP)) AS trans_times
        FROM ${TABLE.TRADE_RECORD} t WHERE t.op = ${OP.BUY}
      ) t2
      ON t2.account_id = t1.account_id AND t2.code = t1.code
         AND t2.entry_count = t1.entry_count AND t2.trans_times < t1.trans_times
    ) t
    LEFT JOIN (SELECT sell_history_id FROM ${TABLE.TRADE_MATCHED}) t2 ON t2.sell_history_id = t.sell_history_id
    LEFT JOIN (SELECT buy_history_id FROM ${TABLE.TRADE_MATCHED}) t3 ON t3.buy_history_id = t.buy_history_id
    WHERE t2.sell_history_id IS NULL AND t3.buy_history_id IS NULL
  ) t
  WHERE t.sell_seq = 1 AND t.buy_seq = 1;`;
