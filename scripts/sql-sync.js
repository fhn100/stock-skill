/**
 * SQL 同步相关定义
 */

import { TABLE, DICT_TYPE } from "./constants.js";

/**
 * 插入账户信息 SQL
 */
export const INSERT_ACCOUNT = `
  INSERT OR REPLACE INTO ${TABLE.DICT}(key, type, value)
  VALUES (?, '${DICT_TYPE.FUND_KEY}', ?)`;
