import { withDb } from './db.js';

async function getYaoMingBi() {
  return await withDb(async (conn) => {
    const rows = await conn.all(`
      SELECT * FROM t_trade_matched_record 
      WHERE code = '02269' 
      ORDER BY sell_time DESC 
      LIMIT 5
    `);
    return rows;
  });
}

getYaoMingBi().then(rows => {
  rows.forEach(r => {
    console.log('sell_time:', r.sell_time, 'code:', r.code, 'name:', r.name, 'profit:', r.profit, 'sell_entry_count:', r.sell_entry_count, 'buy_entry_count:', r.buy_entry_count);
  });
}).catch(e => console.error(e));