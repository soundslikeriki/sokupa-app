import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";
import * as dotenv from "dotenv";

// Load environment variables from .env.local
dotenv.config({ path: ".env.local" });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("❌ Missing Supabase environment variables. Please check .env.local");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const BUCKET_NAME = "wallpapers-catalogs";
const BASE_CATALOGS_DIR = path.join(process.cwd(), "data", "catalogs");

async function walkDir(dir: string, fileList: string[] = []): Promise<string[]> {
  if (!fs.existsSync(dir)) {
    console.warn(`⚠️ Directory not found: ${dir}. Skipping.`);
    return fileList;
  }
  const files = await fs.promises.readdir(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = await fs.promises.stat(filePath);
    if (stat.isDirectory()) {
      await walkDir(filePath, fileList);
    } else if (filePath.toLowerCase().endsWith(".pdf")) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

async function uploadCatalogs() {
  console.log("🚀 Starting wallpaper catalogs automated upload...\n");

  const files = await walkDir(BASE_CATALOGS_DIR);
  if (files.length === 0) {
    console.log(`ℹ️ No PDF files found in ${BASE_CATALOGS_DIR}`);
    console.log(`Please place PDFs in format: data/catalogs/[ManufacturerName]/[CatalogName].pdf`);
    return;
  }

  console.log(`Found ${files.length} PDF files. Processing...`);

  for (const filePath of files) {
    try {
      // Parse file info
      // Expected structure: .../data/catalogs/[ManufacturerName]/[CatalogName].pdf
      const relativePath = path.relative(BASE_CATALOGS_DIR, filePath);
      const parts = relativePath.split(path.sep);
      
      if (parts.length < 2) {
        console.warn(`⚠️ Skipping ${relativePath}: Invalid structure. Expected -> [Manufacturer]/[Catalog].pdf`);
        continue;
      }

      const manufacturerName = parts[0] as string;
      const fileName = parts.slice(1).join("/");
      const catalogName = path.parse(fileName).name; // removes .pdf extension

      console.log(`\n📄 Processing: [${manufacturerName}] ${catalogName} ...`);

      // Check if already in database (Skip logic)
      const { data: existingRecords, error: dbCheckErr } = await supabase
        .from("wallpaper_catalogs")
        .select("id")
        .eq("manufacturer_name", manufacturerName)
        .eq("catalog_name", catalogName);

      if (dbCheckErr) {
        throw new Error(`DB Check Error: ${dbCheckErr.message}`);
      }

      if (existingRecords && existingRecords.length > 0) {
        console.log(`⏭️  Skipping: DB record already exists. (ID: ${existingRecords[0].id})`);
        continue;
      }

      // Upload to Storage
      const storagePath = `${manufacturerName}/${catalogName}_${Date.now()}.pdf`.replace(/\s+/g, '_');
      const fileBuffer = await fs.promises.readFile(filePath);

      console.log("   Uploading to Supabase Storage...");
      const { data: uploadData, error: uploadErr } = await supabase.storage
        .from(BUCKET_NAME)
        .upload(storagePath, fileBuffer, {
          contentType: "application/pdf",
          upsert: false // Don't upsert, generate unique name or skip based on DB
        });

      if (uploadErr) {
        throw new Error(`Storage Upload Error: ${uploadErr.message}`);
      }

      // Get Public URL
      const { data: { publicUrl } } = supabase.storage.from(BUCKET_NAME).getPublicUrl(storagePath);
      console.log(`   Generated URL: ${publicUrl}`);

      // Insert to Database
      console.log("   Registering to database...");
      const { error: insertErr } = await supabase
        .from("wallpaper_catalogs")
        .insert({
          manufacturer_name: manufacturerName,
          catalog_name: catalogName,
          file_url: publicUrl
        });

      if (insertErr) {
        // Option: Rollback storage upload here if needed
        throw new Error(`DB Insert Error: ${insertErr.message}`);
      }

      console.log(`✅ Success: [${manufacturerName}] ${catalogName}`);

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`❌ Failed to process file ${filePath}:`);
      console.error(`   ${msg}`);
      console.log("   Continuing to next file...");
    }
  }

  console.log("\n🎉 Upload process completed.");
}

uploadCatalogs().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
