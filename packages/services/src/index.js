// Start every NeroX service, or one by name: node src/index.js [facilitator|agents|relayer|market]
import { PORTS } from "./config.js";

const only = process.argv[2];
const want = (n) => !only || only === n;

if (want("facilitator")) {
  const { startFacilitator } = await import("./facilitator.js");
  const { startKeeper } = await import("./keeper.js");
  startFacilitator(PORTS.facilitator);
  startKeeper();
}
if (want("agents")) (await import("./agents-host.js")).startAgentsHost(PORTS.agents);
if (want("relayer")) (await import("./relayer.js")).startRelayer(PORTS.relayer);
if (want("market")) {
  (await import("./market-api.js")).startMarketApi(PORTS.market);
  (await import("./traffic.js")).startTraffic();
}
