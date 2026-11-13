import { main } from "../cli.ts";

process.stdout.on("error", () => {});
process.exitCode = await main(process.argv.slice(2));
