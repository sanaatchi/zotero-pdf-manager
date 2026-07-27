import { spawnSync } from "node:child_process";
import path from "node:path";
import esbuild from "esbuild";

const database =
  process.argv[2] || "C:\\Users\\ibrah\\Zotero\\zotero.sqlite";
const python = String.raw`
import json, sqlite3, sys
db = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro&immutable=1", uri=True)
db.row_factory = sqlite3.Row
rows = db.execute("""
SELECT i.itemID, i.key, ty.typeName, f.fieldName, v.value,
       ia.path AS attachmentPath
FROM items i
JOIN itemTypes ty ON ty.itemTypeID=i.itemTypeID
JOIN itemTags jt ON jt.itemID=i.itemID
JOIN tags t ON t.tagID=jt.tagID AND t.name='#auto-created'
LEFT JOIN itemData d ON d.itemID=i.itemID
LEFT JOIN fields f ON f.fieldID=d.fieldID
LEFT JOIN itemDataValues v ON v.valueID=d.valueID
LEFT JOIN itemAttachments ia ON ia.parentItemID=i.itemID
ORDER BY i.itemID
""").fetchall()
items = {}
for row in rows:
    item = items.setdefault(row["itemID"], {
        "itemID": row["itemID"], "key": row["key"],
        "itemType": row["typeName"], "fields": {},
        "attachmentPaths": []
    })
    if row["fieldName"] and row["fieldName"] not in item["fields"]:
        item["fields"][row["fieldName"]] = row["value"]
    if row["attachmentPath"] and row["attachmentPath"] not in item["attachmentPaths"]:
        item["attachmentPaths"].append(row["attachmentPath"])
for item in items.values():
    item["creatorCount"] = db.execute(
        "SELECT COUNT(*) FROM itemCreators WHERE itemID=?", (item["itemID"],)
    ).fetchone()[0]
print(json.dumps(list(items.values()), ensure_ascii=False))
`;
const extracted = spawnSync("python", ["-c", python, database], {
  encoding: "utf8",
  maxBuffer: 50 * 1024 * 1024,
});
if (extracted.status !== 0) {
  process.stderr.write(extracted.stderr);
  process.exit(extracted.status || 1);
}

const built = await esbuild.build({
  entryPoints: ["src/modules/filenameMetadata.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});
const source = Buffer.from(built.outputFiles[0].contents).toString("base64");
const { parseFilenameMetadata, sourceFilenameForMetadata } = await import(
  `data:text/javascript;base64,${source}`
);
const items = JSON.parse(extracted.stdout);
const normalizePath = (value) =>
  value.replace(/^attachments:/, "").replaceAll("/", "\\");
const failures = [];
let complete = 0;
for (const item of items) {
  const attachmentPath = item.attachmentPaths[0] || "";
  const filename = sourceFilenameForMetadata(
    item.fields.extra || "",
    normalizePath(attachmentPath),
  );
  const parsed = parseFilenameMetadata(filename);
  const missing = [];
  if (parsed.title && !item.fields.title) missing.push("title");
  if (parsed.year && !item.fields.date)
    missing.push("date");
  if (parsed.publisher && !item.fields.publisher)
    missing.push("publisher");
  if (
    parsed.publicationTitle &&
    !item.fields.publicationTitle
  )
    missing.push("publicationTitle");
  if (parsed.volume && !item.fields.volume)
    missing.push("volume");
  if (parsed.isbn && !item.fields.ISBN) missing.push("ISBN");
  if (parsed.authors?.length && !item.creatorCount) missing.push("creators");
  if (
    parsed.itemType &&
    parsed.itemType !== "document" &&
    parsed.itemType !== item.itemType
  )
    missing.push(`type:${parsed.itemType}`);
  if (missing.length) {
    failures.push({
      key: item.key,
      filename,
      currentTitle: item.fields.title || "",
      currentType: item.itemType,
      parsed,
      missing,
    });
  } else {
    complete++;
  }
}
console.log(
  JSON.stringify(
    {
      total: items.length,
      complete,
      failed: failures.length,
      failures,
    },
    null,
    2,
  ),
);
