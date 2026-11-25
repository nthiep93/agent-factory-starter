// Public surface of @repo/factory. Each area lives in its own folder
// (src/spec, src/risk, src/metrics) and is re-exported here.
export const FACTORY_PACKAGE = "@repo/factory";
export * from "./risk/index";
export * from "./spec/index";
export * from "./metrics/index";
