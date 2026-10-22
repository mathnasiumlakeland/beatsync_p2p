import { writeFileSync } from "node:fs";
import { join } from "node:path";
const out = join(import.meta.dirname, "..", "out");
const base = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");
writeFileSync(join(out, ".nojekyll"), "");
writeFileSync(
  join(out, "404.html"),
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Beatsync P2P</title><script>location.replace(${JSON.stringify(base + "/")})</script><p><a href="${base}/">Open the listening room</a></p></html>`
);
