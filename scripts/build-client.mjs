import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const DEPLOY_DIR = "!app";
const sourceManifestPath = "manifest.json";
const sourceStylePath = "style.css";

await rm(DEPLOY_DIR, { force: true, recursive: true });
await mkdir(DEPLOY_DIR, { recursive: true });

await build({
  entryPoints: ["src/index.ts"],
  outfile: `${DEPLOY_DIR}/index.js`,
  bundle: true,
  format: "iife",
  globalName: "TogetherBundle",
  platform: "browser",
  target: ["chrome120"],
  sourcemap: false,
  legalComments: "none",
  treeShaking: true,
  minify: false,
  define: {
    "process.env.TOGETHER_VERSION": JSON.stringify(process.env.TOGETHER_VERSION || "v1.0.0-dev")
  },
  footer: {
    js: "\nfunction render(){return TogetherBundle.render();}\n"
  }
});

const manifest = await readFile(sourceManifestPath);
await writeFile(`${DEPLOY_DIR}/manifest.json`, manifest);

try {
  const style = await readFile(sourceStylePath);
  await writeFile(`${DEPLOY_DIR}/style.css`, style);
} catch {
  await writeFile(`${DEPLOY_DIR}/style.css`, "");
}
