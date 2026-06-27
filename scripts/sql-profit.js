/**
 * SQL 收益查询相关定义
 * 包含网格收益查询的 SQL
 */

import { TABLE } from "./constants.js";

/**
 * 网格收益查询 SQL
 * 查询指定时间范围内的收益数据
 * 
 * 返回数据包含：
 * - stock_rows: 每只股票的收益统计
 * - month_rows: 每月收益汇总
 * - year_rows: 年度收益汇总
 * 
 * @param {string} endMonth - 结束月份 YYYY-MM
 * @param {string} startMonth - 开始月份 YYYY-MM
 */
export const GRID_PROFIT = `
  WITH stock_rows AS (
    SELECT account_id, account_name,
      strftime(sell_time, '%Y-%m') AS sell_date, code, name,
      CAST(count(1) AS INTEGER) AS sell_count,
      round(avg(profit), 2) AS grid_profit,
      CAST(sum(profit) AS DOUBLE) AS total_profit,
      'stock' AS row_type
    FROM ${TABLE.TRADE_MATCHED}
    GROUP BY account_id, account_name, sell_date, code, name
  ),
  month_rows AS (
    SELECT account_id, account_name,
      strftime(sell_time, '%Y-%m') AS sell_date,
      '' AS code, '月收益' AS name,
      '' AS sell_count, '' AS grid_profit,
      CAST(sum(profit) AS DOUBLE) AS total_profit,
      'month' AS row_type
    FROM ${TABLE.TRADE_MATCHED}
    GROUP BY account_id, account_name, sell_date
  ),
  year_rows AS (
    SELECT account_id, account_name,
      strftime(max(sell_time), '%Y-%m') AS sell_date,
      '' AS code, '年收益' AS name,
      '' AS sell_count, '' AS grid_profit,
      CAST(sum(profit) AS DOUBLE) AS total_profit,
      'year' AS row_type
    FROM ${TABLE.TRADE_MATCHED}
    WHERE strftime(sell_time, '%Y-%m') <= ?
    GROUP BY account_id, account_name, strftime(sell_time, '%Y')
  )
  SELECT
    substr(t.account_name, 1, strpos(t.account_name, '-')) || substr(t.account_name, strpos(t.account_name, '-') + 1, 1) || '*' AS 账户, t.sell_date AS 时间,
    t.code AS 股票代码, t.name AS 股票名称,
    t.sell_count AS 交易次数, t.grid_profit AS 单次收益,
    t.total_profit AS 总收益
  FROM (
    SELECT * FROM stock_rows
    UNION ALL SELECT * FROM month_rows
    UNION ALL SELECT * FROM year_rows
  ) t
  WHERE (t.sell_date >= ? AND t.sell_date <= ?)
     OR (t.row_type = 'year' AND substr(t.sell_date, 1, 4) = substr(?, 1, 4))
  ORDER BY t.account_name, t.sell_date,
    CASE t.row_type WHEN 'stock' THEN 1 WHEN 'month' THEN 2 WHEN 'year' THEN 3 END,
    t.total_profit DESC;`;
