import { buildApp } from "./app.ts";
import { loadLocalEnvFile, loadServerConfig } from "./config.ts";

loadLocalEnvFile();

const config = loadServerConfig();

const app = await buildApp(config);

await app.listen({ host: config.host, port: config.port });
