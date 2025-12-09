process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const { Client } = require("pg");

const url = process.env.DATABASE_URL;

console.log("Connecting...");

const client = new Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
});

client
  .connect()
  .then(() => {
    console.log("✅ Connected successfully!");
    return client.end();
  })
  .catch((err) => {
    console.error("❌ Connection error:", err);
  });
