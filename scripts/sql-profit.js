/**
 * SQL 收益查询相关定义
 * 包含网格收益查询的 SQL
 */

import { TABLE, MARKET } from "./constants.js";

/**
 * 网格收益查询
 *
 * 分三层聚合：
 * 1. stock — 个股级（按 account_id, account_name, sell_date, code 分组）
 * 2. month — 月汇总（按 account_id, account_name, sell_date 分组）
 * 3. year — 年汇总（按 account_id, account_name, 年份 分组，取该年最大月份）
 *
 * 最终合并排序，输出脱敏的账户名。
 * 
 * @param {string} matchType - 匹配算法标识（lifo/fifo/psf）
 */
export function gridProfitSQL(matchType) {
  return `
WITH cur AS (
  SELECT account_id,
    CASE WHEN BOOL_OR(market_code = '${MARKET.US}') THEN 'USD' ELSE 'CNY' END AS currency
  FROM ${TABLE.TRADE_RECORD}
  GROUP BY account_id
),
stock AS (
  SELECT
    account_id,
    account_name,
    strftime(sell_time, '%Y-%m') AS sell_date,
    code,
    MAX(name) AS name,
    CAST(count(1) AS INTEGER) AS sell_count,
    round(avg(profit), 2) AS grid_profit,
    CAST(sum(profit) AS DOUBLE) AS total_profit,
    'stock' AS row_type
  FROM ${TABLE.TRADE_MATCHED}
  WHERE match_type = '${matchType}'
  GROUP BY account_id, account_name, sell_date, code
),
month AS (
  SELECT
    account_id,
    account_name,
    strftime(sell_time, '%Y-%m') AS sell_date,
    '' AS code,
    '月收益' AS name,
    CAST(count(1) AS INTEGER) AS sell_count,
    '' AS grid_profit,
    CAST(sum(profit) AS DOUBLE) AS total_profit,
    'month' AS row_type
  FROM ${TABLE.TRADE_MATCHED}
  WHERE match_type = '${matchType}'
  GROUP BY account_id, account_name, sell_date
),
year AS (
  SELECT
    account_id,
    account_name,
    strftime(max(sell_time), '%Y-%m') AS sell_date,
    '' AS code,
    '年收益' AS name,
    CAST(count(1) AS INTEGER) AS sell_count,
    '' AS grid_profit,
    CAST(sum(profit) AS DOUBLE) AS total_profit,
    'year' AS row_type
  FROM ${TABLE.TRADE_MATCHED}
  WHERE match_type = '${matchType}'
    AND strftime(sell_time, '%Y-%m') <= ?
  GROUP BY account_id, account_name, strftime(sell_time, '%Y')
)
SELECT
  substr(account_name, 1, strpos(account_name, '-'))
    || substr(account_name, strpos(account_name, '-') + 1, 1) || '*'
    AS "账户",
  cur.currency AS "币种",
  t.sell_date AS "时间",
  t.code AS "股票代码",
  t.name AS "股票名称",
  t.sell_count AS "交易次数",
  t.grid_profit AS "单次收益",
  t.total_profit AS "总收益"
FROM (
  SELECT * FROM stock
  UNION ALL
  SELECT * FROM month
  UNION ALL
  SELECT * FROM year
) t
LEFT JOIN cur ON cur.account_id = t.account_id
WHERE (t.sell_date >= ? AND t.sell_date <= ?)
   OR (t.row_type = 'year' AND substr(t.sell_date, 1, 4) = substr(?, 1, 4))
ORDER BY
  t.account_name,
  t.sell_date,
  CASE t.row_type
    WHEN 'stock' THEN 1
    WHEN 'month' THEN 2
    WHEN 'year' THEN 3
  END,
  t.total_profit DESC
`;
}