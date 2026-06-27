/**
 * SQL 同步相关定义
 * 包含账户同步和交易记录同步的 SQL
 */

import { TABLE, PAGE_SIZE, API_BASE, API_PATH, HTTP_HEADERS, API_DEFAULTS, DICT_TYPE } from "./constants.js";

/**
 * 同步账户信息 SQL
 * 从 API 获取账户列表并插入/更新到字典表
 */
export const SYNC_ACCOUNT = `
  WITH __input AS (
    SELECT http_post(
      '${API_BASE}${API_PATH.ACCOUNT_LIST}',
      headers := {
        'User-Agent': '${HTTP_HEADERS.USER_AGENT}',
        'Content-Type': '${HTTP_HEADERS.CONTENT_TYPE}',
        'Origin': '${HTTP_HEADERS.ORIGIN}',
        'Referer': '${HTTP_HEADERS.REFERER}',
        'cookie': ?
      },
      params := { 'userid': ?, 'user_id': ?, 'terminal': '${API_DEFAULTS.TERMINAL}', 'version': '${API_DEFAULTS.VERSION}' }
    ) AS res
  ),
  __response AS (
    SELECT unnest(from_json(((decode(res.body)->>'ex_data')::JSON)->'common', '["json"]')) AS common FROM __input
  )
  INSERT OR REPLACE INTO ${TABLE.DICT}(key, type, value)
  SELECT t.common->>'fund_key' AS key, '${DICT_TYPE.FUND_KEY}' AS type, t.common->>'manualname' AS value
  FROM __response t;`;

/**
 * 同步交易记录 SQL
 * 从 API 获取交易记录并插入/更新到交易记录表
 * 支持分页，每页最多 PAGE_SIZE 条记录
 */
export const SYNC_TRADE = `
  WITH __input AS (
    SELECT http_post(
      '${API_BASE}${API_PATH.SYNC_TRADE}',
      headers := {
        'User-Agent': '${HTTP_HEADERS.USER_AGENT}',
        'Content-Type': '${HTTP_HEADERS.CONTENT_TYPE}',
        'Origin': '${HTTP_HEADERS.ORIGIN}',
        'Referer': '${HTTP_HEADERS.REFERER}',
        'cookie': ?
      },
      params := {
        'userid': ?, 'user_id': ?, 'fund_key': ?,
        'stock_code': '', 'stock_account': '',
        'start_date': ?, 'end_date': ?, 'page': ?,
        'count': '${PAGE_SIZE}', 'sort_type': '', 'sort_order': '1'
      }
    ) AS res
  ),
  __response AS (
    SELECT unnest(from_json(((decode(res.body)->>'ex_data')::JSON)->'list', '["json"]')) AS list FROM __input
  )
  INSERT OR REPLACE INTO ${TABLE.TRADE_RECORD}
    (account_id, account_name, account_type, code, commission, entry_cost, entry_count,
     entry_date, entry_money, entry_price, entry_time, entry_date_time, fee_total,
     history_id, manual_id, market_code, name, oid, op, op_name, transfer_fee)
  SELECT
    t1.list->>'account_id', t2.account_name, t1.list->>'account_type', t1.list->>'code',
    TRY_CAST(t1.list->>'commission' AS DECIMAL(10,4)),
    TRY_CAST(t1.list->>'entry_cost' AS DECIMAL(10,4)),
    t1.list->>'entry_count', t1.list->>'entry_date',
    TRY_CAST(t1.list->>'entry_money' AS DECIMAL(10,4)),
    TRY_CAST(t1.list->>'entry_price' AS DECIMAL(10,4)),
    t1.list->>'entry_time',
    concat(t1.list->>'entry_date', ' ', t1.list->>'entry_time'),
    TRY_CAST(t1.list->>'fee_total' AS DECIMAL(10,4)),
    concat(t1.list->>'account_id',
      EXTRACT(EPOCH FROM(((t1.list->>'entry_date')::DATE + (t1.list->>'entry_time')::TIME)::TIMESTAMP))::BIGINT,
      t1.list->>'code', t1.list->>'op', t1.list->>'entry_count'),
    t1.list->>'manual_id', t1.list->>'market_code', t1.list->>'name',
    t1.list->>'oid', t1.list->>'op', t1.list->>'op_name',
    TRY_CAST(t1.list->>'transfer_fee' AS DECIMAL(10,4))
  FROM __response t1
  INNER JOIN (
    SELECT key AS account_id, value AS account_name
    FROM ${TABLE.DICT} WHERE type = '${DICT_TYPE.FUND_KEY}'
  ) t2 ON t2.account_id = (t1.list->>'account_id');`;