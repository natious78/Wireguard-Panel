Object.assign(process.env,{
  NODE_ENV:process.env.NODE_ENV||"test",
  APP_URL:process.env.APP_URL||"http://localhost:2040",
  APP_ENCRYPTION_KEY:process.env.APP_ENCRYPTION_KEY||Buffer.alloc(32,7).toString("base64"),
  DEMO_MODE:process.env.DEMO_MODE||"false",
});

if (!process.env.DATABASE_URL && !process.env.DB_HOST) {
  process.env.DATABASE_URL="postgresql://test:test@127.0.0.1:5432/test";
}
