/**
 * Create the first (or another) admin user for Utils login.
 * Usage:
 *   Set env vars: ADMIN_USERNAME, ADMIN_PASSWORD
 *   Or: node scripts/create-admin-user.cjs <username> <password>
 * Requires: MONGODB_URI (and optionally DATABASE_NAME) in .env
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { MongoClient } = require("mongodb");
const bcrypt = require("bcryptjs");

const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = process.env.DATABASE_NAME || "integration-factor";
const USERS_COLLECTION = "users";

const BCRYPT_ROUNDS = 12;

async function main() {
  const username = process.argv[2] || process.env.ADMIN_USERNAME;
  const password = process.argv[3] || process.env.ADMIN_PASSWORD;

  if (!MONGODB_URI) {
    console.error("Error: MONGODB_URI is not set. Add it to .env in the project root.");
    process.exit(1);
  }
  if (!username || !password) {
    console.error("Usage: node scripts/create-admin-user.cjs <username> <password>");
    console.error("   Or set ADMIN_USERNAME and ADMIN_PASSWORD in .env");
    process.exit(1);
  }

  const normalizedUsername = username.trim().toLowerCase();
  if (normalizedUsername.length === 0) {
    console.error("Username cannot be empty.");
    process.exit(1);
  }

  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DATABASE_NAME);
    const users = db.collection(USERS_COLLECTION);

    const existing = await users.findOne({ username: normalizedUsername });
    if (existing) {
      const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      await users.updateOne(
        { username: normalizedUsername },
        { $set: { passwordHash: hash, updatedAt: new Date() } }
      );
      console.log(`Updated password for user "${normalizedUsername}".`);
    } else {
      const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      await users.insertOne({
        username: normalizedUsername,
        passwordHash: hash,
        createdAt: new Date(),
      });
      console.log(`Created user "${normalizedUsername}". You can now log in on the Utils page.`);
    }
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();
