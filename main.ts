import { main } from "./src/cli/main.ts";

Deno.exit(await main(Deno.args));
