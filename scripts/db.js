/**
 * 数据库连接管理
 * 单例模式，复用 DuckDB 连接
 */

import { DuckDBInstance } from "@duckdb/node-api";
import { join } from "path";
import { getDataDir } from "./utils.js";

// ============================ --db 选项 ============================

/**
 * `--db <path>` 是 `STOCK_DB_OVERRIDE` 环境变量的命令行糖：两者都指向同一份覆盖路径，
 * 便于隔离测试时不写正式库。提取该选项并写入 env，返回去掉它之后的其余参数。
 * @param {string[]} argv 例如 process.argv.slice(2)
 * @returns {string[]} 剩余参数（位置参数与其它选项）
 */
export function extractDbFlag(argv) {
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) { console.error("错误: --db 缺少路径参数"); process.exit(1); }
      process.env.STOCK_DB_OVERRIDE = v;
    } else if (a.startsWith("--db=")) {
      process.env.STOCK_DB_OVERRIDE = a.slice("--db=".length);
    } else {
      rest.push(a);
    }
  }
  return rest;
}

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
    // 测试/隔离用：STOCK_DB_OVERRIDE 指定完整路径时不写正式库
    if (process.env.STOCK_DB_OVERRIDE) return process.env.STOCK_DB_OVERRIDE;
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
   * 同步关闭连接（process "exit" 钩子内无法 await，只释放连接与文件锁）
   */
  closeConnSync() {
    try {
      this._conn?.close();
    } catch (_) {}
    this._conn = null;
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
 * 执行数据库操作
 * @param {Function} fn - 接收 (db) 的回调，db 是 DatabaseManager 实例
 * @returns {Promise<*>} fn 的返回值
 */
// ⚠️ withDb 复用同一个单例连接：多次调用共享同一条连接，因此在某处 `BEGIN` 后、
// 跨若干次 withDb 执行的语句仍属同一事务（见 profit.js 清理+重配）。若将来把此处
// 改为「每次调用新建连接」，BEGIN/COMMIT 会落到不同连接上而静默失效——务必保持单例。
export async function withDb(fn) {
  await dbManager.getConnection();
  return await fn(dbManager);
}

// 进程退出清理
process.on("exit", () => dbManager.closeConnSync());
process.on("SIGINT", async () => {
  try { await dbManager.closeConnection(); } catch (_) {}
  process.exit(0);
});
process.on("SIGTERM", async () => {
  try { await dbManager.closeConnection(); } catch (_) {}
  process.exit(0);
});