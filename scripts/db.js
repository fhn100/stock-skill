import { Database } from "duckdb-async";
import { join } from "path";
import { getDataDir } from "./utils.js";
import { CREATE_DICT, CREATE_TRADE_RECORD, CREATE_TRADE_MATCHED } from "./sql-schema.js";
import { SYNC_ACCOUNT, SYNC_TRADE } from "./sql-sync.js";
import { TRADE_MATCH } from "./sql-match.js";
import { GRID_PROFIT } from "./sql-profit.js";

process.noDeprecation = true;

// ============================ 数据库连接管理 ============================

/**
 * 数据库连接管理器（单例模式）
 */
class DatabaseManager {
  constructor() {
    this._conn = null;
    this._httpLoaded = false;
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
      this._conn = await Database.create(this.getDbPath());
    }
    
    // HTTP 扩展只需加载一次
    if (!this._httpLoaded) {
      await this._conn.run("INSTALL http_request FROM community; LOAD http_request;");
      this._httpLoaded = true;
    }
    
    return this._conn;
  }

  /**
   * 关闭数据库连接
   */
  async closeConnection() {
    if (this._conn) {
      try {
        await this._conn.close();
      } catch (e) {
        console.error("关闭数据库连接失败:", e);
      }
      this._conn = null;
      this._httpLoaded = false;
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
 * 自动管理预处理语句的生命周期
 * @param {Function} fn - 接收 (conn, stmt) 的回调
 * @param {string} [sql] - 预处理 SQL（如提供则自动 prepare）
 * @returns {Promise<*>} fn 的返回值
 */
export async function withDb(fn, sql) {
  const conn = await dbManager.getConnection();
  const stmt = sql ? await conn.prepare(sql) : null;
  try {
    return await fn(conn, stmt);
  } finally {
    if (stmt) {
      try { await stmt.finalize(); } catch (_) {}
    }
  }
}

// 进程退出清理（内部函数，不导出）
async function closeDbManager() {
  await dbManager.closeConnection();
}

process.on("SIGINT", async () => { try { await closeDbManager(); } catch (_) {} process.exit(0); });
process.on("SIGTERM", async () => { try { await closeDbManager(); } catch (_) {} process.exit(0); });

// ============================ 常量 ============================

/**
 * SQL 定义对象（导出给其他模块使用）
 */
export const SQL = {
  CREATE_DICT,
  CREATE_TRADE_RECORD,
  CREATE_TRADE_MATCHED,
  SYNC_ACCOUNT,
  SYNC_TRADE,
  TRADE_MATCH,
  GRID_PROFIT,
};
