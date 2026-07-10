import { DuckDBInstance } from "@duckdb/node-api";
import { join } from "path";
import { getDataDir } from "./utils.js";
import { CREATE_DICT, CREATE_TRADE_RECORD, CREATE_TRADE_MATCHED } from "./sql-schema.js";
import { INSERT_ACCOUNT, INSERT_TRADE } from "./sql-sync.js";
import { TRADE_MATCH } from "./sql-match.js";
import { GRID_PROFIT } from "./sql-profit.js";

process.noDeprecation = true;

// ============================ 数据库连接管理 ============================

/**
 * 数据库连接管理器（单例模式）
 */
class DatabaseManager {
  constructor() {
    this._instance = null;
    this._conn = null;
  }

  /**
   * 获取数据库文件路径
   * @returns {string} 数据库文件路径
   */
  getDbPath() {
    return join(getDataDir(), "stock.db");
  }

  /**
   * 获取数据库连接（复用连接）
   * @returns {Promise<object>} 数据库连接对象
   */
  async getConnection() {
    if (!this._conn) {
      this._instance = await DuckDBInstance.create(this.getDbPath());
      this._conn = await this._instance.connect();
    }
    return this._conn;
  }

  /**
   * 执行查询
   * @param {string} sql - SQL 语句
   * @param {Array} params - 参数
   * @returns {Promise<Array>} 查询结果
   */
  async all(sql, params = []) {
    const conn = await this.getConnection();
    const reader = await conn.runAndReadAll(sql, params);
    return reader.getRowObjects();
  }

  /**
   * 执行单条查询并返回第一行
   * @param {string} sql - SQL 语句
   * @param {Array} params - 参数
   * @returns {Promise<Object>} 第一行数据
   */
  async get(sql, params = []) {
    const conn = await this.getConnection();
    const reader = await conn.runAndReadAll(sql, params);
    const rows = reader.getRowObjects();
    return rows[0] || null;
  }

  /**
   * 执行语句（INSERT/UPDATE/DELETE）
   * @param {string} sql - SQL 语句
   * @param {Array} params - 参数
   * @returns {Promise<void>}
   */
  async run(sql, params = []) {
    const conn = await this.getConnection();
    await conn.run(sql, params);
  }

  /**
   * 关闭数据库连接
   */
  async closeConnection() {
    if (this._conn) {
      try {
        this._conn = null;
        this._instance = null;
      } catch (e) {
        console.error("关闭数据库连接失败:", e);
      }
    }
  }
}

// 单例实例
const dbManager = new DatabaseManager();

// ============================ 导出函数 ============================

/**
 * 获取数据库文件路径
 * @returns {string} 数据库文件路径
 */
export function getDbPath() {
  return dbManager.getDbPath();
}

/**
 * 执行数据库操作的通用封装
 * @param {Function} fn - 接收 (db, stmt) 的回调
 * @param {string} [sql] - 预处理 SQL（如提供则自动 prepare）
 * @returns {Promise<*>} fn 的返回值
 */
export async function withDb(fn, sql) {
  const conn = await dbManager.getConnection();
  if (sql) {
    return await fn(dbManager, { all: async (...params) => {
      const reader = await conn.runAndReadAll(sql, params);
      return reader.getRowObjects();
    }});
  }
  return await fn(dbManager, null);
}

// 进程退出清理
process.on("SIGINT", async () => { try { await dbManager.closeConnection(); } catch (_) {} process.exit(0); });
process.on("SIGTERM", async () => { try { await dbManager.closeConnection(); } catch (_) {} process.exit(0); });

// ============================ 常量 ============================

/**
 * SQL 定义对象（导出给其他模块使用）
 */
export const SQL = {
  CREATE_DICT,
  CREATE_TRADE_RECORD,
  CREATE_TRADE_MATCHED,
  TRADE_MATCH,
  GRID_PROFIT,
};

export { INSERT_ACCOUNT, INSERT_TRADE };
