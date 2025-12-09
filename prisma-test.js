import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function test() {
  try {
    console.log("Connecting with Prisma...");
    await prisma.$queryRaw`SELECT NOW()`;
    console.log("✅ Prisma connected successfully!");
  } catch (err) {
    console.error("❌ Prisma connection failed:", err);
  } finally {
    await prisma.$disconnect();
  }
}

test();
