import { defineConfig } from "tsup";
export default defineConfig({
  entry: { index: "src/index.ts", web3: "src/web3/index.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
  external: ["viem"],
});
