/**
 * 数据库连接管理
 * 单例模式，复用 DuckDB 连接
 */

import { DuckDBInstance } from "@duckdb/node-api";
import { join } from "path";
import { getDataDir } from "./utils.js";

// ============================ 数据库连接管理器 ============================

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
   * @returns {Promise<object>} DuckDBConnection 对象
   */
  async getConnection() {
    if (!this._conn) {
      this._instance = await DuckDBInstance.create(this.getDbPath());
      this._conn = await this._instance.connect();
    }
    return this._conn;
  }

  /**
   * 正确关闭数据库连接并释放文件锁
   */
  async closeConnection() {
    if (this._conn) {
      try {
        this._conn.close();
      } catch (e) {
        console.error("关闭数据库连接失败:", e);
      }
      this._conn = null;
    }
    if (this._instance) {
      try {
        await this._instance.close();
      } catch (e) {
        console.error("关闭数据库实例失败:", e);
      }
      this._instance = null;
    }
  }

  /**
   * 执行查询并返回所有行
   * @param {string} sql - SQL 语句
   * @param {Array} params - 参数
   * @returns {Promise<Array>} 查询结果对象数组
   */
  async all(sql, params = []) {
    const conn = await this.getConnection();
    const reader = await conn.runAndReadAll(sql, params);
    return reader.getRowObjects();
  }

  /**
   * 执行语句（INSERT/UPDATE/DELETE/CREATE）
   * @param {string} sql - SQL 语句
   * @param {Array} params - 参数
   * @returns {Promise<object>} 执行结果
   */
  async run(sql, params = []) {
    const conn = await this.getConnection();
    return await conn.run(sql, params);
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
 * 执行数据库操作
 * @param {Function} fn - 接收 (db) 的回调，db 是 DatabaseManager 实例
 * @returns {Promise<*>} fn 的返回值
 */
export async function withDb(fn) {
  await dbManager.getConnection();
  return await fn(dbManager);
}

// 进程退出清理
process.on("SIGINT", async () => {
  try { await dbManager.closeConnection(); } catch (_) {}
  process.exit(0);
});
process.on("SIGTERM", async () => {
  try { await dbManager.closeConnection(); } catch (_) {}
  process.exit(0);
});