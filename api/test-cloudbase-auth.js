import cloudbase from "@cloudbase/node-sdk";

try {
  const app = cloudbase.init({
    env: process.env.CLOUDBASE_ENV_ID,
    accessKey: process.env.CLOUDBASE_APIKEY
  });
  const collection = app.database().collection("fishtank_configs");
  const result = await collection.where({ type: "decorations" }).limit(1).get();
  console.log("AUTH_TEST_OK");
  console.log(`RECORD_COUNT ${result.data.length}`);
} catch (error) {
  console.log("AUTH_TEST_FAILED");
  console.log(`NAME ${error?.name || ""}`);
  console.log(`MESSAGE ${error?.message || ""}`);
  if (error?.code !== undefined) console.log(`CODE ${error.code}`);
}
