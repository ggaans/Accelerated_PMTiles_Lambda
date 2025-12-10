// index.mjs - Production PMTiles Lambda

import crypto from "crypto";
import zlib from "zlib";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { PMTiles, SharedPromiseCache, Source } from "pmtiles";

// ====== Environment ======
const BUCKET = process.env.BUCKET;
const CORS = process.env.CORS;
const PUBLIC_HOSTNAME = process.env.PUBLIC_HOSTNAME;
const PMTILES_PATH = process.env.PMTILES_PATH || "{name}.pmtiles";
const CACHE_CONTROL = process.env.CACHE_CONTROL || "public, max-age=86400";

if (!BUCKET) throw new Error("BUCKET env var is required");

// ====== AWS S3 Client ======
const s3 = new S3Client({
  requestHandler: new (await import("@aws-sdk/node-http-handler")).NodeHttpHandler({
    connectionTimeout: 750,
    socketTimeout: 750,
  }),
});

// ====== Path Parsing ======
const TILE_PATH_RE =
  /^\/(?<name>[0-9a-zA-Z\/!\-_\.\*'()]+)\/(?<z>\d+)\/(?<x>\d+)\/(?<y>\d+)\.(?<ext>[a-z]+)$/;
const JSON_PATH_RE =
  /^\/(?<name>[0-9a-zA-Z\/!\-_\.\*'()]+)\.json$/;

// ====== PMTiles Source Implementation (S3 Range Reads) ======
class S3RangeSource extends Source {
  constructor(name) {
    super();
    this.name = name;
  }

  getKey() {
    return this.name;
  }

  async getBytes(offset, length, signal, etag) {
    const key = PMTILES_PATH.replaceAll("{name}", this.name);

    const params = {
      Bucket: BUCKET,
      Key: key,
      Range: `bytes=${offset}-${offset + length - 1}`,
      RequestPayer: "requester",
    };
    if (etag) params.IfMatch = etag;

    const res = await s3.send(new GetObjectCommand(params));
    const bytes = Buffer.from(await res.Body.transformToByteArray());

    return {
      data: bytes.buffer,
      etag: res.ETag,
      cacheControl: res.CacheControl ?? undefined,
      expires: res.Expires?.toISOString(),
    };
  }
}

// ====== Tile Type Handling ======
const TILE_INFO = {
  1: { ext: "mvt", mime: "application/vnd.mapbox-vector-tile" },
  2: { ext: "png", mime: "image/png" },
  3: { ext: "jpg", mime: "image/jpeg" },
  4: { ext: "webp", mime: "image/webp" },
  5: { ext: "avif", mime: "image/avif" },
};

// ====== Shared Cache ======
const cache = new SharedPromiseCache();

function getPMTilesReader(name) {
  return new PMTiles(new S3RangeSource(name), cache);
}

// ====== Helpers ======
const responseBinary = (status, body, headers = {}) => ({
  statusCode: status,
  headers,
  body: body.toString("base64"),
  isBase64Encoded: true,
});

const responseText = (status, body, headers = {}) => ({
  statusCode: status,
  headers,
  body,
});

function applyCORS(headers) {
  if (CORS) headers["Access-Control-Allow-Origin"] = CORS;
}

function clientHostname(eventHeaders) {
  const h = eventHeaders["x-distribution-domain-name"];
  return PUBLIC_HOSTNAME || h;
}

// ====== Main Handler ======
export const handler = async (event) => {
  const isRest = !!event.pathParameters?.proxy;
  const path = isRest
    ? `/${event.pathParameters.proxy}`
    : event.rawPath ?? event.path;

  const headersIn = {};
  for (const [k, v] of Object.entries(event.headers || {}))
    headersIn[k.toLowerCase()] = v;

  const headersOut = {};
  applyCORS(headersOut);

  // ---- TileJSON ----
  const jsonMatch = JSON_PATH_RE.exec(path);
  if (jsonMatch) {
    const name = jsonMatch.groups.name;
    const host = clientHostname(headersIn);
    if (!host)
      return responseText(501, "TileJSON requires PUBLIC_HOSTNAME", headersOut);

    const reader = getPMTilesReader(name);
    const header = await reader.getHeader();
    const metadata = await reader.getMetadata().catch(() => ({}));

    const info = TILE_INFO[header.tileType];
    const ext = info?.ext ?? "bin";

    const baseUrl = `https://${host}/${name}`;
    const tileJson = {
      tilejson: "3.0.0",
      scheme: "xyz",
      tiles: [`${baseUrl}/{z}/{x}/{y}.${ext}`],
      bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
      center: [header.centerLon, header.centerLat, header.centerZoom],
      minzoom: header.minZoom,
      maxzoom: header.maxZoom,
      ...metadata,
    };

    headersOut["Content-Type"] = "application/json";
    return responseText(200, JSON.stringify(tileJson), headersOut);
  }

  // ---- Tiles ----
  const tileMatch = TILE_PATH_RE.exec(path);
  if (!tileMatch) return responseText(400, "Invalid tile path", headersOut);

  const { name, z, x, y, ext } = tileMatch.groups;
  const reader = getPMTilesReader(name);
  const header = await reader.getHeader();

  const zi = +z;
  if (zi < header.minZoom || zi > header.maxZoom)
    return responseText(404, "", headersOut);

  const info = TILE_INFO[header.tileType];
  if (!info) return responseText(500, "Unknown tile type", headersOut);

  // Allow .pbf alias for MVT
  if (!(header.tileType === 1 && ext === "pbf") && ext !== info.ext)
    return responseText(
      400,
      `Bad request: requested .${ext} but archive has type .${info.ext}`,
      headersOut
    );

  const tile = await reader.getZxy(zi, +x, +y);
  if (!tile) return responseText(204, "", headersOut);

  let data = Buffer.from(tile.data);

  headersOut["Content-Type"] = info.mime;
  headersOut["Cache-Control"] = CACHE_CONTROL;
  headersOut["ETag"] = `"${crypto.createHash("sha256").update(data).digest("hex")}"`;

  // Gzip only for API Gateway REST style
  if (isRest) {
    data = zlib.gzipSync(data);
    headersOut["Content-Encoding"] = "gzip";
  }

  return responseBinary(200, data, headersOut);
};
