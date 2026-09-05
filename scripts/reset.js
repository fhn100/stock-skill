#!/usr/bin/env node

/**
 * 数据重置重跑脚本
 * 用法: node reset.js [options]
 *   --start <YYYYMMDD>       开始日期（闭区间）
 *   --end <YYYYMMDD>         结束日期（闭区间），默认当月1日～今天
 *   --months <YYYY-MM,...>   直接指定年月列表（优先于 start/end）
 *   --dry-run                只输出待删除行数，不做任何修改
 *   --sync                   删除后重新同步交易记录
 *   --match                  同步后重新匹配买卖记录
 *   --settle <N>             同步结束日期往前推 N 天（T+N 结算），重跑历史月份必用
 *   --no-backup              跳过备份（不建议）
 *   --force                  存在运行中的 sync/match 进程时仍继续（不建议）
 *
 * 行为：
 * 1. 自动备份数据库到 ~/.duckdb/stock/backup/stock.<时间戳>.db
 * 2. 按 t_trade_record.entry_date / t_trade_matched_record.sell_time 的年月精确删除
 * 3. 可选重跑 sync/match
 */

import fs from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { withDb, getDbPath } from "./db.js";
import { TABLE } from "./constants.js";
import { syncTrade, tradeMatch } from "./business.js";

// ============================ 参数解析 ============================

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    start: null,
    end: null,
    months: null,
    dryRun: false,
    sync: false,
    match: false,
    settle: 0,
    noBackup: false,
    force: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--start": opts.start = args[++i]; break;
      case "--end": opts.end = args[++i]; break;
      case "--months": opts.months = args[++i]; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--sync": opts.sync = true; break;
      case "--match": opts.match = true; break;
      case "--settle": opts.settle = parseInt(args[++i], 10) || 0; break;
      case "--no-backup": opts.noBackup = true; break;
      case "--force": opts.force = true; break;
      default:
        console.error(`未知参数: ${args[i]}`);
        process.exit(1);
    }
  }
  return opts;
}

// ============================ 日期工具 ============================

function todayYyyymmdd() {
  const n = new Date();
  return `${n.getFullYear()}${String(n.getMonth() + 1).padStart(2, "0")}${String(n.getDate()).padStart(2, "0")}`;
}

function currentMonth() {
  return todayYyyymmdd().substring(0, 7);
}

function validateYyyymmdd(s) {
  if (!/^\d{8}$/.test(s)) throw new Error(`日期格式错误: ${s}（应为 YYYYMMDD）`);
}

/** 枚举 [startMonth, endMonth] 之间的所有年月，格式 YYYY-MM（startMonth/endMonth 为 YYYY-MM） */
function enumerateMonths(startMonth, endMonth) {
  if (!/^\d{4}-\d{2}$/.test(startMonth) || !/^\d{4}-\d{2}$/.test(endMonth)) {
    throw new Error(`年月格式错误: ${startMonth} ~ ${endMonth}（应为 YYYY-MM）`);
  }
  const months = [];
  let [y, m] = startMonth.split("-").map(Number);
  const [ey, em] = endMonth.split("-").map(Number);
  // 上限保护：最多枚举 1200 个月，防止异常输入导致死循环
  for (let i = 0; i < 1200 && (y < ey || (y === ey && m <= em)); i++) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  if (months.length === 0) throw new Error(`无效的年月范围: ${startMonth} ~ ${endMonth}`);
  return months;
}

/** 月末日期，格式 YYYYMMDD */
function monthEnd(yyyyMm) {
  const [y, m] = yyyyMm.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${y}${String(m).padStart(2, "0")}${String(last).padStart(2, "0")}`;
}

/** 往前推 N 天，格式 YYYYMMDD */
function minusDays(yyyymmdd, n) {
  const d = new Date(
    parseInt(yyyymmdd.substring(0, 4), 10),
    parseInt(yyyymmdd.substring(4, 6), 10) - 1,
    parseInt(yyyymmdd.substring(6, 8), 10) - n,
  );
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

// ============================ 主流程 ============================

const opts = parseArgs();

try {
  // 1. 解析年月列表
  let months;
  if (opts.months) {
    months = opts.months.split(",").map((s) => s.trim());
    if (months.some((m) => !/^\d{4}-\d{2}$/.test(m))) {
      throw new Error("--months 格式错误（应为 YYYY-MM 逗号分隔）");
    }
  } else {
    const start = opts.start || `${currentMonth()}01`;
    const end = opts.end || todayYyyymmdd();
    validateYyyymmdd(start);
    validateYyyymmdd(end);
    const toYm = (s) => `${s.substring(0, 4)}-${s.substring(4, 6)}`;
    months = enumerateMonths(toYm(start), toYm(end));
  }
  months.sort();

  // 2. 同步范围（重跑用）：最早月开始 ~ 最晚月末，--settle 往前推
  const today = todayYyyymmdd();
  let syncStart = `${months[0]}01`;
  let syncEnd = monthEnd(months[months.length - 1]);
  if (opts.settle > 0) syncEnd = minusDays(syncEnd, opts.settle);
  // 未来日期防护：API 对未来日期返回空数据
  if (syncEnd > today) {
    console.log(`⚠️  同步结束日期 ${syncEnd} 晚于今天，已截断为 ${today}（历史月份请配合 --settle N）`);
    syncEnd = today;
  }

  // 3. 进程互斥检查（DuckDB 单写者锁）
  if (!opts.force && !opts.dryRun) {
    try {
      const out = execSync(`pgrep -af "(sync|match|reset)\\.js" || true`, { encoding: "utf8" });
      const others = out.trim().split("\n").filter((l) => l && !l.includes(String(process.pid)));
      if (others.length > 0) {
        console.error("❌ 检测到运行中的 sync/match/reset 进程，为避免锁冲突已中止：");
        console.error(others.join("\n"));
        console.error("确认无并发后重试，或使用 --force 强制继续（不建议）");
        process.exit(1);
      }
    } catch (e) {
      if (e.code !== 1) throw e; // pgrep 无匹配时退出码为 1，属正常
    }
  }

  const dbPath = getDbPath();

  // 4. 备份（dry-run 除外）
  if (!opts.dryRun && !opts.noBackup) {
    const backupDir = join(process.env.HOME, ".duckdb", "stock", "backup");
    fs.mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[-:T]/g, "").substring(0, 14);
    const backupPath = join(backupDir, `stock.${ts}.db`);
    fs.copyFileSync(dbPath, backupPath);
    console.log(`✅ 已备份数据库: ${backupPath}`);
  }

  // 5. 统计/删除
  const monthList = months.map((m) => `'${m}'`).join(",");
  await withDb(async (db) => {
    for (const [label, table, dateCol] of [
      ["交易记录", TABLE.TRADE_RECORD, "entry_date"],
      ["匹配记录", TABLE.TRADE_MATCHED, "sell_time"],
    ]) {
      const where =
        dateCol === "entry_date"
          ? `substr(${dateCol}, 1, 7) IN (${monthList})`
          : `strftime(${dateCol}, '%Y-%m') IN (${monthList})`;
      const rows = await db.all(`SELECT count(*) AS n FROM ${table} WHERE ${where}`);
      const count = Number(rows[0]?.n ?? 0);
      console.log(`${months[0]} ~ ${months[months.length - 1]} ${label}待删除: ${count} 条`);
      if (!opts.dryRun && count > 0) {
        await db.run(`DELETE FROM ${table} WHERE ${where}`);
        console.log(`  ✅ 已删除 ${label} ${count} 条`);
      }
    }
  });

  if (opts.dryRun) {
    console.log("\n（--dry-run 模式，未做任何修改）");
    process.exit(0);
  }

  // 6. 可选重跑 sync/match
  if (opts.sync) {
    console.log(`\n开始重新同步: ${syncStart} ~ ${syncEnd}`);
    await syncTrade(syncStart, syncEnd);
  }
  if (opts.match) {
    if (!opts.sync) {
      console.log(`\n开始重新同步（match 前置）: ${syncStart} ~ ${syncEnd}`);
      await syncTrade(syncStart, syncEnd);
    }
    await tradeMatch();
  }

  console.log("\n重置完成。如需统计收益，执行: node profit.js " + months[months.length - 1]);
} catch (e) {
  console.error("重置失败:", e.message);
  process.exit(1);
}
