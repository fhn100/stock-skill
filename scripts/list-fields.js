import { withDb } from './db.js';

async function checkFields() {
  return await withDb(async (conn) => {
    const row = await conn.all("SELECT * FROM t_trade_matched_record WHERE code = '02269' ORDER BY sell_time DESC LIMIT 1");
    console.log(row[0] ? Object.keys(row[0]) : 'no rows');
  });
}

checkFields().then(r => console.log('Fields: ', r)).catch(e => console.error(e));