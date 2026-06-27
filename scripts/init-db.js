#!/usr/bin/env node

/**
 * 独立数据库初始化脚本 - 不依赖 opencli
 * 用法: node init-db.js
 * 功能: 初始化数据库表结构并同步账户信息
 */

import { initDb, initAccount } from "./business.js";
import { getConfigPath } from "./utils.js";
import { getDbPath } from "./db.js";

try {
  console.log("配置文件路径：" + getConfigPath());
  console.log("数据库路径：" + getDbPath());

  // 初始化数据库表结构
  await initDb();
  console.log("数据库初始化完成");

  // 同步账户信息
  await initAccount();
  console.log("账户初始化完成");
} catch (e) {
  console.error("初始化失败:", e.message);
  process.exit(1);
}
