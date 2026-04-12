import favicons from "favicons";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const defaultSource = path.join(__dirname, "favicon-source.svg");

function parseOutputDir() {
  const i = process.argv.indexOf("--output");
  if (i >= 0 && process.argv[i + 1]) {
    return path.resolve(process.cwd(), process.argv[i + 1]);
  }
  return path.join(projectRoot, "public");
}

const source = defaultSource;
const dest = parseOutputDir();

const response = await favicons(source, {
  path: "/",
  appName: "ソクパ",
  lang: "ja",
});

await mkdir(dest, { recursive: true });
await Promise.all(response.images.map((img) => writeFile(path.join(dest, img.name), img.contents)));
await Promise.all(
  response.files.map((f) => writeFile(path.join(dest, f.name), f.contents, "utf8")),
);

console.log(`Favicons: wrote ${response.images.length} images + ${response.files.length} files → ${dest}`);
