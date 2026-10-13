import favicons from "favicons";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
// The existing Sokupa emblem recovered from repository history, with safe padding.
const defaultSource = path.join(__dirname, "sokupa-install-icon-source.png");

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
  appShortName: "ソクパ",
  appDescription: "計測メモ画像から品番・数量を読み取り、メーカー別に整理します。",
  lang: "ja",
  scope: "/",
  start_url: "/?homescreen=1",
  icons: {
    android: { background: "#fff", transparent: false },
    appleIcon: true,
    appleStartup: false,
    favicons: true,
    windows: false,
    yandex: false,
  },
  manifestMaskable: true,
});

await mkdir(dest, { recursive: true });
await Promise.all(response.images.map((img) => writeFile(path.join(dest, img.name), img.contents)));
await Promise.all(
  response.files.map((f) => writeFile(path.join(dest, f.name), f.contents, "utf8")),
);

console.log(`Favicons: wrote ${response.images.length} images + ${response.files.length} files → ${dest}`);
