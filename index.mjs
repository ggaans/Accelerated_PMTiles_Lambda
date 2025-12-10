// index.mjs (Node.js 20/22 Lambda)

// External deps (install with npm or pnpm):
//   npm install pmtiles @aws-sdk/client-s3
import crypto from "crypto";
import zlib from "zlib";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { PMTiles, SharedPromiseCache } from "pmtiles";

/**
 * Environment variables:
 *  - BUCKET          (required) S3 bucket name containing the .pmtiles
 *  - PMTILES_PATH    (optional) pattern for S3 key, e.g. "tiles/{name}.pmtiles"
 *                    If not set, default is "{name}.pmtiles"
 *  - PUBLIC_HOSTNAME (optional) used to build TileJSON URLs (otherwise use CF header)
 *  - CORS            (optional) e.g. "*" or "https://example.com"
 *  - CACHE_CONTROL   (optional) default "public, max-age=86400"
 */

const s3 = new S3Client({
  // You can tune these if you like; defaults are fine too
  requestHandler: {
    handle: (...args) => {
      // Let the default Node handler be created by the SDK. We only define
      // this wrapper if you want explicit timeouts/behaviour; otherwise you
      // can remove this "requestHandler" block entirely.
      const { NodeHttpHandler } = require("@aws-sdk/node-http-handler");
      const handler = new NodeHttpHandler({
        connectionTimeout: 500,
        socketTimeout: 500
      });
      return handler.handle(...args);
    }
  }
});

// ---- Helpers -------------------------------------------------------------

const TILE_PATH_RE = /^\/(?<name>[0-9a-zA-Z\/!\-_\.\*'()]+)\/(?<z>\d+)\/(?<x>\d+)\/(?<y>\d+)\.(?<ext>[a-z]+)$/;
const TILEJSON_PATH_RE = /^\/(?<name>[0-9a-zA-Z\/!\-_\.\*'()]+)\.json$/;

/** Map PMTiles tileType enum to extension + content-type */
function tileTypeToInfo(tileType) {
  // PMTiles spec: 1=MVT, 2=PNG, 3=JPEG, 4=WEBP, 5=AVIF
  switch (tileType) {
    case 1:
      return { ext: ".mvt",  contentType: "application/vnd.mapbox-vector-tile" };
    case 2:
      return { ext: ".png",  contentType: "image/png" };
    case 3:
      return { ext: ".jpg",  contentType: "image/jpeg" };
    case 4:
      return { ext: ".webp", contentType: "image/webp" };
    case 5:
      return { ext: ".avif", contentType: "image/avif" };
    default:
      return { ext: "", contentType: "application/octet-stream" };
  }
}

/** Build S3 key from name and optional PMTILES_PATH pattern */
function pmtilesKeyForName(name) {
  const pattern = process.env.PMTILES_PATH;
  if (!pattern) return `${name}.pmtiles`;
  // allow something like "tiles/{name}.pmtiles"
  return pattern.replaceAll("{name}", name);
}

/** Basic Lambda proxy response builder */
function makeResponse(statusCode, body, options = {}) {
  const {
    headers = {},
    isBase64Encoded = false
  } = options;

  // Allow simple global CORS
  if (process.env.CORS) {
    headers["Access-Control-Allow-Origin"] = process.env.CORS;
  }

  return {
    statusCode,
    body,
    headers,
    isBase64Encoded
  };
}

/**
 * Parse the path into either:
 *  - { type: "tilejson", name }
 *  - { type: "tile", name, z, x, y, ext }
 *  - or null if invalid
 */
function parsePath(path) {
  const tileMatch = path.match(TILE_PATH_RE);
  if (tileMatch && tileMatch.groups) {
    const { name, z, x, y, ext } = tileMatch.groups;
    return {
      type: "tile",
      name,
      z: Number(z),
      x: Number(x),
      y: Number(y),
      ext
    };
  }

  const jsonMatch = path.match(TILEJSON_PATH_RE);
  if (jsonMatch && jsonMatch.groups) {
    const { name } = jsonMatch.groups;
    return {
      type: "tilejson",
      name
    };
  }

  return null;
}

// ---- PMTiles S3 Source implementation ------------------------------------

/**
 * A simple PMTiles "Source" that fetches bytes from S3
 * using Range requests.
 */
class S3PmtilesSource {
  constructor(archiveName) {
    this.archiveName = archiveName;
  }

  getKey() {
    return this.archiveName;
  }

  /**
   * PMTiles expects: getBytes(offset, length, signal?, etag?)
   * We’ll ignore signal here for simplicity.
   */
  async getBytes(offset, length, signal, etag) {
    const bucket = process.env.BUCKET;
    if (!bucket) {
      throw new Error("BUCKET env var is required");
    }

    const key = pmtilesKeyForName(this.archiveName);

    const params = {
      Bucket: bucket,
      Key: key,
      Range: `bytes=${offset}-${offset + length - 1}`,
      RequestPayer: "requester"
    };

    if (etag) {
      // Guard against bad intermediaries rewriting content
      params.IfMatch = etag;
    }

    let res;
    try {
      res = await s3.send(new GetObjectCommand(params));
    } catch (err) {
      // If the ETag doesn't match, PMTiles code will treat this as a "retry with fresh header" error
      // You may want to adapt this to match pmtiles' Q/etag error type if needed.
      throw err;
    }

    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) {
      throw new Error("Failed to read S3 response body");
    }

    return {
      data: bytes.buffer,
      etag: res.ETag,
      cacheControl: res.CacheControl || undefined,
      expires: res.Expires ? res.Expires.toISOString() : undefined
    };
  }
}

// Shared cache across invocations (if Lambda keeps container warm)
const pmtilesCache = new SharedPromiseCache();

/** Create/reuse a PMTiles instance for a given archive name */
function getArchive(name) {
  const source = new S3PmtilesSource(name);
  return new PMTiles(source, pmtilesCache);
}

// ---- TileJSON builder ----------------------------------------------------

async function buildTileJson(name, archive, event) {
  const header = await archive.getHeader();
  const metadata = await archive.getMetadata().catch(() => ({}));
  const { ext } = tileTypeToInfo(header.tileType);

  // Determine base hostname
  // 1. PUBLIC_HOSTNAME env var (e.g. tiles.example.com)
  // 2. CloudFront header from the viewer-request function
  const cfDomain =
    event.headers?.["x-distribution-domain-name"] ||
    event.headers?.["X-Distribution-Domain-Name"];

  const host = process.env.PUBLIC_HOSTNAME || cfDomain;
  if (!host) {
    throw new Error("No PUBLIC_HOSTNAME or x-distribution-domain-name available for TileJSON");
  }

  const baseUrl = `https://${host}/${name}`;
  const tiles = [`${baseUrl}/{z}/{x}/{y}${ext}`];

  return {
    tilejson: "3.0.0",
    scheme: "xyz",
    tiles,
    // Copy through whatever metadata exists if provided
    vector_layers: metadata.vector_layers,
    attribution: metadata.attribution,
    description: metadata.description,
    name: metadata.name,
    version: metadata.version,
    bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
    center: [header.centerLon, header.centerLat, header.centerZoom],
    minzoom: header.minZoom,
    maxzoom: header.maxZoom
  };
}

// ---- Main handler --------------------------------------------------------

export const handler = async (event) => {
  // Determine path:
  // - API Gateway proxy: event.pathParameters.proxy
  // - Lambda Function URL: event.rawPath
  let path;
  let cameFromApiGateway = false;

  if (event.pathParameters && event.pathParameters.proxy) {
    // API Gateway REST/HTTP proxy integration
    path = `/${event.pathParameters.proxy}`;
    cameFromApiGateway = true;
  } else if (event.rawPath) {
    // Lambda Function URL or HTTP API
    path = event.rawPath;
  } else {
    return makeResponse(500, "Invalid event configuration");
  }

  const parsed = parsePath(path);
  if (!parsed) {
    return makeResponse(400, "Invalid tile URL");
  }

  try {
    if (parsed.type === "tilejson") {
      const archive = getArchive(parsed.name);
      const tileJson = await buildTileJson(parsed.name, archive, event);

      return makeResponse(200, JSON.stringify(tileJson), {
        headers: {
          "Content-Type": "application/json"
        }
      });
    }

    // Tile request
    const { name, z, x, y, ext } = parsed;
    const archive = getArchive(name);
    const header = await archive.getHeader();

    // Zoom bounds check
    if (z < header.minZoom || z > header.maxZoom) {
      return makeResponse(404, "");
    }

    // Tile type vs extension validation
    const { ext: archiveExt, contentType } = tileTypeToInfo(header.tileType);

    if (header.tileType === 1 && ext === "pbf") {
      // Special case: allow .pbf for MVT
      // OK
    } else if (archiveExt && `.${ext}` !== archiveExt) {
      return makeResponse(
        400,
        `Bad request: requested .${ext} but archive has type ${archiveExt}`
      );
    }

    const tileResult = await archive.getZxy(z, x, y);

    if (!tileResult) {
      // No tile present: 204 No Content
      return makeResponse(204, "");
    }

    let tileBytes = Buffer.from(tileResult.data);

    // Compute ETag (sha256 of tile content)
    const etag = `"${crypto.createHash("sha256").update(tileBytes).digest("hex")}"`;

    // Default headers
    const headers = {
      "Content-Type": contentType,
      "Cache-Control": process.env.CACHE_CONTROL || "public, max-age=86400",
      ETag: etag
    };

    // If request came via API Gateway proxy, we may want to gzip encode
    // the body and set Content-Encoding. For Lambda Function URL +
 CloudFront
    // you can let CloudFront handle compression if you like.
    if (cameFromApiGateway) {
      tileBytes = zlib.gzipSync(tileBytes);
      headers["Content-Encoding"] = "gzip";
    }

    return makeResponse(200, tileBytes.toString("base64"), {
      headers,
      isBase64Encoded: true
    });
  } catch (err) {
    console.error("Error serving PMTiles tile:", err);

    if (err.name === "AccessDenied") {
      return makeResponse(403, "Bucket access unauthorized");
    }

    // Optional: be more defensive and hide internals for production
    return makeResponse(500, "Internal server error");
  }
};
