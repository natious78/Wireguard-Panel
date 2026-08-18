Object.assign(process.env,{
  NODE_ENV:"test",
  DATABASE_URL:"postgresql://test:test@127.0.0.1:5432/test",
  APP_URL:"http://localhost:2040",
  APP_ENCRYPTION_KEY:Buffer.alloc(32,7).toString("base64"),
  DEMO_MODE:"false",
});
