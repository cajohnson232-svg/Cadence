// Prints the engine input for an interval exactly as the app compiles it.
//   tsx tests/compile-check.ts iv_7 > /tmp/ts.json
import "dotenv/config";
import { compileInterval } from "../src/lib/compile";

compileInterval(process.argv[2] ?? "iv_7").then((c) => {
  process.stdout.write(JSON.stringify({ config: c.config, compiled: c.compiledRules.map((r) => [r.origin, r.id, r.engine, r.level, r.text]), warnings: c.warnings }));
  process.exit(0);
}).catch((e) => { console.error(e); process.exit(1); });
