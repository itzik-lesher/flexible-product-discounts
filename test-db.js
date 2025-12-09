import pkg from "pg";
const { Client } = pkg;

// Use the Session pooler connection string from Supabase
const connectionString =
  "postgresql://postgres.[db name]:[pass] @aws-1 - eu - north - 1.pooler.supabase.com: 6543 / postgres";

const client = new Client({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false,
  },
});

async function testConnection() {
  try {
    console.log("🔄 Testing Session Pooler connection...\n");

    await client.connect();
    console.log("✅ SUCCESS! Connected via Session Pooler!\n");

    const res = await client.query("SELECT NOW() as current_time");
    console.log("📅 Current time:", res.rows[0].current_time);

    await client.end();
    console.log("\n✅ Connection works! Use this URL in your Fly.io app.");
  } catch (err) {
    console.error("❌ Failed:", err.message);
  }
}

testConnection();
