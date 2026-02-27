var db = require("better-sqlite3")("/data/bitcorn.db");
var rows = db.prepare("SELECT * FROM coinbase_onramp_sessions ORDER BY created_at DESC LIMIT 5").all();
console.log(JSON.stringify(rows, null, 2));
